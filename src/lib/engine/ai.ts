import { AIRCRAFT_MODELS, blockHoursSlots, defaultSeatConfig, getModel } from '$data/aircraft';
import { AIRPORTS, getAirport } from '$data/airports';
import { smallestGateForCategory } from '$data/gates';
import {
	acquireAircraft,
	addScheduleEntry,
	availableGatesAt,
	cancelListing,
	companyGates,
	companyValuation,
	createRoute,
	hireWorkers,
	listSharesForSale,
	postTransaction,
	scheduleForAircraft,
	scheduleOverlaps
} from '$db/repo';
import { HIRING_FEE, companyHolderId, db, isAiRun, type Company } from '$db/schema';
import { gameNow } from './clock';
import { dailyLeaseBill } from './economy';
import { distanceKm } from './geo';
import { idealCargoRate, idealPrices } from './demand';
import { pickOne, randomIntBetween, seededRng, type Rng } from './rng';

/**
 * Cash floor below which an AI airline starts raising money by selling equity. Exported
 * because it is also the line at which a board stops holding out for a premium on a takeover
 * bid: the same shortage that makes an airline float shares makes it tender them.
 */
export const CASH_FLOOR = 2_500_000;
export const CASH_COMFORTABLE = 12_000_000;
const MAX_LISTING_SHARES = 400;

/**
 * Expansion floors. Every route carries 46 staff and every gate 10, so an AI that
 * keeps buying while short of cash simply bleeds out — it has to hold a buffer.
 */
const AIRCRAFT_CASH_FLOOR = 8_000_000;
const ROUTE_CASH_FLOOR = 4_500_000;

/**
 * A lease is signed on its deposit, so the purchase floor would block carriers that
 * can comfortably fly the aircraft. What has to hold instead is the daily bill, and
 * it has to hold for the whole fleet: leases judged one at a time stack up until
 * their combined charge is what bleeds the carrier out.
 */
const LEASE_RUNWAY_DAYS = 60;

/**
 * Hiring appetite, at its keenest: the share of cash an airline will put into fees in a
 * single day. Converting the whole roster at once is the efficient move and the one no
 * real airline makes.
 */
const MAX_HIRING_BUDGET_SHARE = 0.15;

/** Below this keenness an airline runs on agency staff and never gets round to hiring. */
const NEVER_HIRES_BELOW = 0.25;

const settleIncidents = async (company: Company, at: number): Promise<void> => {
	const pending = await db.incidents
		.where('[companyId+status]')
		.equals([company.id!, 'pending'])
		.toArray();

	for (const incident of pending) {
		await postTransaction(
			company.id!,
			'incident_settlement',
			-incident.baseAmount,
			`Indemnity paid for accident of ${incident.aircraftName}`,
			{ at, allowOverdraft: true, refId: `incident:${incident.id}` }
		);
		await db.incidents.update(incident.id!, {
			status: 'settled',
			outcome: 'Settled out of court',
			finalAmount: incident.baseAmount,
			resolvedAt: at
		});
		await db.aircraft.update(incident.aircraftId, {
			status: 'maintenance',
			maintenanceUntil: at + 48 * 3_600_000
		});
	}
};

/** Decide whether to raise capital by floating shares, or to pull listings back in. */
const manageShareListings = async (company: Company, rng: Rng): Promise<void> => {
	const holderId = companyHolderId(company.id!);
	const listings = (await db.share_listings.where('companyId').equals(company.id!).toArray()).filter(
		(listing) => listing.sellerId === holderId
	);
	const { sharePrice } = await companyValuation(company.id!);

	if (company.cash < CASH_FLOOR) {
		const treasury = await db.shareholdings
			.where('[companyId+holderId]')
			.equals([company.id!, holderId])
			.first();
		const listed = listings.reduce((sum, listing) => sum + listing.quantity, 0);
		const available = (treasury?.quantity ?? 0) - listed;

		if (available > 0) {
			const quantity = Math.min(available, randomIntBetween(rng, 50, MAX_LISTING_SHARES));
			const price = Math.round(sharePrice * (0.95 + rng() * 0.12));
			await listSharesForSale(company.id!, holderId, quantity, price);
		}
		return;
	}

	if (company.cash > CASH_COMFORTABLE && listings.length > 0 && rng() < 0.5) {
		// Flush with cash: stop diluting and take the float back off the market.
		await cancelListing(listings[0].id!);
		return;
	}

	// Otherwise keep asking prices honest.
	for (const listing of listings) {
		const price = Math.round(sharePrice * (0.97 + rng() * 0.1));
		if (price !== listing.pricePerShare) {
			await db.share_listings.update(listing.id!, { pricePerShare: price });
		}
	}
};

const buyAircraftIfSensible = async (company: Company, rng: Rng): Promise<void> => {
	if (rng() > 0.45) return;

	const gates = await companyGates(company.id!);
	if (gates.length === 0) return;

	const bestGate = gates.reduce((best, gate) => (gate.maxCategory > best.maxCategory ? gate : best));

	// Settled before the shortlist, because the two routes to an airframe are priced
	// nothing alike: a purchase costs the list price, a lease only its deposit.
	const ownership = rng() < 0.3 ? 'leased' : 'owned';
	if (ownership === 'owned' && company.cash < AIRCRAFT_CASH_FLOOR) return;

	const budget = company.cash * 0.45;
	const committedLease =
		ownership === 'leased'
			? dailyLeaseBill(await db.aircraft.where('companyId').equals(company.id!).toArray())
			: 0;

	const affordable = AIRCRAFT_MODELS.filter((model) => {
		if (model.category > bestGate.maxCategory) return false;
		if (ownership === 'owned') return model.price <= budget;

		return (
			model.leaseDeposit <= budget &&
			(committedLease + model.leaseDailyRate) * LEASE_RUNWAY_DAYS <= company.cash
		);
	});
	if (affordable.length === 0) return;

	// Prefer the largest affordable type, with some spread so fleets differ.
	const shortlist = affordable.slice(-8);
	const model = pickOne(rng, shortlist);

	try {
		await acquireAircraft({
			companyId: company.id!,
			modelId: model.id,
			name: `${company.icao}-${model.name}`,
			seats: defaultSeatConfig(model),
			ownership,
			homeGateId: bestGate.key
		});
	} catch {
		// Not enough cash after other spending this day; try again tomorrow.
	}
};

const openRouteIfNeeded = async (company: Company, rng: Rng): Promise<void> => {
	const [fleet, routes, gates] = await Promise.all([
		db.aircraft.where('companyId').equals(company.id!).toArray(),
		db.routes.where('companyId').equals(company.id!).toArray(),
		companyGates(company.id!)
	]);

	if (fleet.length === 0 || gates.length === 0) return;
	if (company.cash < ROUTE_CASH_FLOOR) return;
	// One route per airframe: a bidirectional route already fills an aircraft's day.
	if (routes.length >= fleet.length) return;
	if (rng() > 0.55) return;

	const homeGate =
		gates.find((gate) => gate.airportIata === company.homeIata) ??
		gates.reduce((best, gate) => (gate.maxCategory > best.maxCategory ? gate : best));
	const home = getAirport(homeGate.airportIata);

	const longestRange = Math.max(...fleet.map((aircraft) => getModel(aircraft.modelId).range));

	// Shortlist destination airports first, then pull only that airport's free stands,
	// so a daily AI turn never scans all eight thousand gates.
	const servedAirports = new Set(routes.map((route) => route.toIata));
	const destinations = AIRPORTS.filter((airport) => {
		if (airport.iataCode === homeGate.airportIata) return false;
		if (servedAirports.has(airport.iataCode)) return false;
		const distance = distanceKm(home, airport);
		return distance <= longestRange && distance > 150;
	})
		.sort((left, right) => right.tier - left.tier)
		.slice(0, 20);

	if (destinations.length === 0) return;

	const destination = pickOne(rng, destinations);
	const freeGates = await availableGatesAt(destination.iataCode);
	const affordable = freeGates.filter((gate) => gate.price <= company.cash * 0.35);

	// The stand only has to take the aircraft that will actually fly there. Reaching for
	// the largest affordable one buys apron the fleet cannot fill and pays its departure
	// fees on every leg.
	const heaviestInFleet = fleet.reduce(
		(heaviest, aircraft) => Math.max(heaviest, getModel(aircraft.modelId).category),
		0
	);
	const target = smallestGateForCategory(affordable, heaviestInFleet);
	if (!target) return;

	const distance = Math.round(distanceKm(home, destination));
	const ideal = idealPrices(distance);

	try {
		await createRoute(company.id!, homeGate.key, target.key, {
			economy: Math.round(ideal.economy * (0.92 + rng() * 0.2)),
			business: Math.round(ideal.business * (0.92 + rng() * 0.2)),
			first: Math.round(ideal.first * (0.92 + rng() * 0.2))
		});
	} catch {
		// Gate taken or cash short this day.
	}
};

const fillEmptySlots = async (company: Company, rng: Rng): Promise<void> => {
	const [fleet, routes] = await Promise.all([
		db.aircraft.where('companyId').equals(company.id!).toArray(),
		db.routes.where('companyId').equals(company.id!).toArray()
	]);
	if (routes.length === 0) return;

	for (const aircraft of fleet) {
		if (aircraft.status === 'grounded') continue;

		const model = getModel(aircraft.modelId);
		const existing = await scheduleForAircraft(aircraft.id!);
		const flyable = routes.filter(
			(route) => route.distanceKm <= model.range && route.fromIata === aircraft.currentIata
		);
		const anyFlyable = flyable.length > 0 ? flyable : routes.filter((route) => route.distanceKm <= model.range);
		if (anyFlyable.length === 0) continue;

		// Aim for a handful of legs a week per airframe.
		const target = randomIntBetween(rng, 3, 8);
		let attempts = 0;

		while (existing.length < target && attempts < 12) {
			attempts += 1;
			const route = pickOne(rng, anyFlyable);
			const blockHours = blockHoursSlots(model, route.distanceKm);
			const dayOfWeek = randomIntBetween(rng, 0, 6);
			const startHour = randomIntBetween(rng, 0, Math.max(0, 24 - blockHours));

			if (startHour + blockHours > 24) continue;
			if (scheduleOverlaps(existing, { dayOfWeek, startHour, blockHours })) continue;

			try {
				await addScheduleEntry(company.id!, aircraft.id!, route.id!, dayOfWeek, startHour);
				existing.push({
					id: -1,
					companyId: company.id!,
					aircraftId: aircraft.id!,
					routeId: route.id!,
					dayOfWeek,
					startHour,
					blockHours,
					createdAt: gameNow()
				});
			} catch {
				continue;
			}
		}
	}
};

const repriceRoutes = async (company: Company, rng: Rng): Promise<void> => {
	const routes = await db.routes.where('companyId').equals(company.id!).toArray();

	for (const route of routes) {
		if (rng() > 0.35) continue;
		const ideal = idealPrices(route.distanceKm);
		await db.routes.update(route.id!, {
			prices: {
				economy: Math.round(ideal.economy * (0.88 + rng() * 0.3)),
				business: Math.round(ideal.business * (0.88 + rng() * 0.3)),
				first: Math.round(ideal.first * (0.88 + rng() * 0.3))
			},
			cargoRatePerTonne: Math.round(idealCargoRate(route.distanceKm) * (0.9 + rng() * 0.25))
		});
	}
};

/**
 * How an airline feels about payroll, fixed for its whole life. Seeded on the airline
 * rather than the day because the daily rng is reseeded every morning: rolling
 * reluctance fresh each day averages every carrier into the same middling manager within
 * a few weeks. Tied to the ICAO code, a carrier that does not care never starts caring.
 */
const hiringDispositionOf = (company: Company): { reviewChance: number; budgetShare: number } => {
	const keenness = seededRng('ai-hiring', company.icao)();
	if (keenness < NEVER_HIRES_BELOW) return { reviewChance: 0, budgetShare: 0 };

	return {
		reviewChance: 0.04 + keenness * 0.26,
		budgetShare: MAX_HIRING_BUDGET_SHARE * keenness
	};
};

/**
 * Taking an external worker onto the payroll saves the daily difference in wages and
 * pays its fee back inside a fortnight, so an airline that never hires quietly overpays
 * for its whole existence. Which is exactly what some of them do: the keen ones convert
 * in weeks, the slow ones trickle, and a quarter of the field never bothers.
 */
const hireWorkersIfSensible = async (company: Company, rng: Rng): Promise<void> => {
	const { reviewChance, budgetShare } = hiringDispositionOf(company);
	if (reviewChance <= 0) return;
	if (rng() > reviewChance) return;
	if (company.external_workers <= 0) return;

	// Fees are due the same day, and hiring is never worth an overdraft — a carrier
	// already in the red has nothing to convert with.
	const affordable = Math.min(
		company.external_workers,
		Math.floor((company.cash * budgetShare) / HIRING_FEE)
	);
	if (affordable <= 0) return;

	const toHire = randomIntBetween(rng, 0, affordable);
	if (toHire <= 0) return;

	try {
		await hireWorkers(company.id!, toHire);
	} catch {
		// Cash went elsewhere earlier in the day; the roster is still there tomorrow.
	}
};

/**
 * One day of decisions for every AI-run airline. Guarded by `lastAiDay`, so a
 * catch-up over ten days runs it exactly ten times, never twice for one day.
 */
export const runAiDay = async (dayIndex: number): Promise<number> => {
	// Scanned rather than queried on the `controller` index, because an airline whose owner
	// hired a chief executive is AI-run too and that flag is not indexed. Thirteen rows, and
	// the daily charges already read the whole table anyway.
	const companies = (await db.companies.toArray()).filter(isAiRun);
	const at = dayIndex * 86_400_000;
	let acted = 0;

	for (const stale of companies) {
		if (stale.lastAiDay >= dayIndex) continue;

		const company = await db.companies.get(stale.id!);
		if (!company || !isAiRun(company)) continue;

		const rng = seededRng('ai', company.id!, dayIndex);

		await settleIncidents(company, at);
		await manageShareListings(company, rng);
		await buyAircraftIfSensible(await refresh(company.id!), rng);
		await openRouteIfNeeded(await refresh(company.id!), rng);
		await fillEmptySlots(await refresh(company.id!), rng);
		await repriceRoutes(company, rng);
		await hireWorkersIfSensible(await refresh(company.id!), rng);

		await db.companies.update(company.id!, { lastAiDay: dayIndex });
		acted += 1;
	}

	return acted;
};

const refresh = async (companyId: number): Promise<Company> => {
	const company = await db.companies.get(companyId);
	if (!company) throw new Error('Company vanished mid-turn');
	return company;
};
