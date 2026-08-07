import {
	blockHoursSlots,
	categoryWithinBudget,
	getModel,
	seatConfigFits,
	totalSeats
} from '$data/aircraft';
import { findAirport, getAirport } from '$data/airports';
import type { ClassAmounts, GateBlueprint, SeatConfig } from '$data/types';
import { gateBlueprint, gatesForAirport, smallestGateForCategory } from '$data/gates';
import { idealCargoRate } from '$engine/demand';
import { DAY_NAMES_LONG, dayIndexOf, gameNow } from '$engine/clock';
import { distanceKm } from '$engine/geo';
import { aircraftResaleValue, hiringCost, valuation, type Valuation } from '$engine/economy';
import { resolveLawsuit, type LawsuitOutcome } from '$engine/maintenance';
import { startMaintenance } from '$engine/flights';
import { liveRandomIntBetween } from '$engine/rng';
import {
	CONTROL_THRESHOLD,
	EMPLOYEES_PER_GATE,
	EMPLOYEES_PER_ROUTE,
	PLAYER_HOLDER_ID,
	STARTING_CASH,
	TOTAL_SHARES,
	companyHolderId,
	holderBrokerId,
	holderCompanyId,
	db,
	pairKeyOf,
	type Aircraft,
	type Company,
	type GateOwnership,
	type OwnedGate,
	type Route,
	type BidStatus,
	type ShareListing,
	type ShareTrade,
	type TakeoverBid,
	type TransactionCategory,
	type TransactionRecord
} from './schema';

export class GameError extends Error {}

/**
 * Per-class figures arrive from the UI as Svelte `$state` objects, which are
 * proxies — IndexedDB cannot structured-clone those and throws DataCloneError.
 * Every write of a seat layout or fare table goes through here, which also stops
 * the stored row from aliasing a caller's mutable object.
 */
const plainAmounts = (value: ClassAmounts | SeatConfig): ClassAmounts => ({
	economy: value.economy,
	business: value.business,
	first: value.first
});

/**
 * Share of an opening balance that can realistically go into the first airframe — the
 * rest has to cover the destination stand, the staff and a few weeks of running costs.
 * Sizes the founding stand: the airline gets apron for what it can actually fly.
 */
const FIRST_FLEET_SHARE = 0.5;

const requireCompany = async (companyId: number): Promise<Company> => {
	const company = await db.companies.get(companyId);
	if (!company) throw new GameError('Company not found');
	return company;
};

/**
 * The only path by which cash ever moves. Keeps `companies.cash` and the
 * transaction ledger in lockstep inside one write transaction.
 */
export const postTransaction = async (
	companyId: number,
	category: TransactionCategory,
	amount: number,
	description: string,
	options: { at?: number; refId?: string | null; allowOverdraft?: boolean } = {}
): Promise<void> => {
	const at = options.at ?? gameNow();
	const company = await requireCompany(companyId);

	if (amount < 0 && !options.allowOverdraft && company.cash + amount < 0) {
		throw new GameError('Not enough cash');
	}

	await db.companies.update(companyId, { cash: company.cash + amount });
	await db.transaction_records.add({
		companyId,
		at,
		day: dayIndexOf(at),
		direction: amount >= 0 ? 'income' : 'expense',
		category,
		amount,
		description,
		refId: options.refId ?? null
	});
};

const adjustWorkers = async (companyId: number, externalDelta: number): Promise<void> => {
	const company = await requireCompany(companyId);
	await db.companies.update(companyId, {
		external_workers: Math.max(0, company.external_workers + externalDelta)
	});
};

/* ------------------------------------------------------------------ companies */

export const slugify = (value: string): string =>
	value
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'airline';

export const uniqueSlug = async (name: string): Promise<string> => {
	const base = slugify(name);
	let candidate = base;
	let suffix = 2;

	while (await db.companies.where('slug').equals(candidate).first()) {
		candidate = `${base}-${suffix}`;
		suffix += 1;
	}
	return candidate;
};

export const isIcaoTaken = async (icao: string): Promise<boolean> => {
	const existing = await db.companies.where('icao').equals(icao.toUpperCase()).first();
	return Boolean(existing);
};

const COMPANY_COLOURS = [
	'#00d09c',
	'#ff3b30',
	'#ffcc00',
	'#0d1e40',
	'#7c3aed',
	'#ec4899',
	'#0ea5e9',
	'#f97316',
	'#14b8a6',
	'#84cc16',
	'#8b5cf6',
	'#dc2626',
	'#2563eb'
];

export const pickCompanyColour = (index: number): string =>
	COMPANY_COLOURS[index % COMPANY_COLOURS.length];

export interface CreateCompanyInput {
	name: string;
	icao: string;
	homeIata: string;
	controller?: 'player' | 'ai';
	cash?: number;
	colour?: string;
}

/**
 * Founds an airline: all 3.000 shares to the founder, plus one free gate at the
 * chosen home airport (the best stand still available there).
 */
export const createCompany = async (input: CreateCompanyInput): Promise<Company> => {
	const controller = input.controller ?? 'player';
	const slug = await uniqueSlug(input.name);
	const now = gameNow();
	const companyCount = await db.companies.count();
	const cash = input.cash ?? STARTING_CASH;

	const companyId = await db.companies.add({
		slug,
		name: input.name.trim(),
		icao: input.icao.trim().toUpperCase(),
		controller,
		cash,
		homeIata: input.homeIata,
		hired_workers: 0,
		external_workers: 0,
		marketMultiplier: 1,
		firstAircraftDelivered: 0,
		lastAiDay: 0,
		createdAt: now,
		colour: input.colour ?? pickCompanyColour(companyCount)
	});

	await db.shareholdings.add({
		companyId,
		holderId: controller === 'player' ? PLAYER_HOLDER_ID : companyHolderId(companyId),
		quantity: TOTAL_SHARES
	});

	await grantFreeGate(companyId, input.homeIata, categoryWithinBudget(cash * FIRST_FLEET_SHARE));

	return requireCompany(companyId);
};

/**
 * The free home gate: the smallest unowned stand that still takes the largest aircraft
 * the airline's opening balance could buy. A founder handed a category 10 pier it can
 * only park a turboprop on would pay that pier's departure fees for the whole game.
 */
export const grantFreeGate = async (
	companyId: number,
	airportIata: string,
	requiredCategory: number
): Promise<OwnedGate | null> => {
	const available = await availableGatesAt(airportIata);
	if (available.length === 0) return null;

	// When the field has nothing that big left, take its largest rather than leaving the
	// airline without a base at all.
	const home =
		smallestGateForCategory(available, requiredCategory) ??
		available.reduce((left, right) => (right.maxCategory > left.maxCategory ? right : left));

	// The founding gate is a gift: no transaction, but it still carries its staff.
	return claimGate(companyId, home, { free: true });
};

export const getCompanyBySlug = async (slug: string): Promise<Company | undefined> =>
	db.companies.where('slug').equals(slug).first();

export const playerCompanies = async (): Promise<Company[]> => {
	const companies = await db.companies.where('controller').equals('player').toArray();
	return companies.sort((left, right) => left.createdAt - right.createdAt);
};

export const companyValuation = async (companyId: number): Promise<Valuation> => {
	const company = await requireCompany(companyId);
	const [fleet, gates, routeCount] = await Promise.all([
		db.aircraft.where('companyId').equals(companyId).toArray(),
		companyGates(companyId),
		db.routes.where('companyId').equals(companyId).count()
	]);

	return valuation({ company, fleet, gates, routeCount }, company.marketMultiplier);
};

/* ---------------------------------------------------------------------- gates */

/**
 * Stands are derived from the airport dataset, so the database only records who owns
 * what. Everything below joins the two: `gatesForAirport` supplies the stand, the
 * `gate_ownership` table supplies the holder.
 */

const ownershipAt = async (airportIata: string): Promise<Map<string, GateOwnership>> => {
	const owned = await db.gate_ownership.where('airportIata').equals(airportIata).toArray();
	return new Map(owned.map((row) => [row.gateKey, row]));
};

const toOwnedGate = (blueprint: GateBlueprint, ownership: GateOwnership): OwnedGate => ({
	...blueprint,
	companyId: ownership.companyId,
	purchasedAt: ownership.purchasedAt
});

/** Records the purchase of a stand and bills for it. */
const claimGate = async (
	companyId: number,
	blueprint: GateBlueprint,
	options: { free?: boolean } = {}
): Promise<OwnedGate> => {
	const airport = getAirport(blueprint.airportIata);

	if (!options.free) {
		await postTransaction(
			companyId,
			'gate_purchase',
			-blueprint.price,
			`Gate ${blueprint.number} at ${airport.iataCode} (${airport.city})`,
			{ refId: `gate:${blueprint.key}` }
		);
	}

	const purchasedAt = gameNow();
	await db.gate_ownership.add({
		gateKey: blueprint.key,
		airportIata: blueprint.airportIata,
		companyId,
		purchasedAt
	});
	await adjustWorkers(companyId, EMPLOYEES_PER_GATE);

	return { ...blueprint, companyId, purchasedAt };
};

export const buyGate = async (companyId: number, key: string): Promise<OwnedGate> => {
	const blueprint = gateBlueprint(key);
	if (!blueprint) throw new GameError('Gate not found');

	const existing = await db.gate_ownership.get(key);
	if (existing) throw new GameError('That gate already belongs to an airline');

	return claimGate(companyId, blueprint);
};

/** Stands still for sale at an airport, cheapest rating first. */
export const availableGatesAt = async (airportIata: string): Promise<GateBlueprint[]> => {
	if (!findAirport(airportIata)) return [];

	const owned = await ownershipAt(airportIata);
	return gatesForAirport(airportIata)
		.filter((gate) => !owned.has(gate.key))
		.sort(
			(left, right) =>
				left.maxCategory - right.maxCategory || left.number.localeCompare(right.number)
		);
};

export const availableGateCountAt = async (airportIata: string): Promise<number> => {
	if (!findAirport(airportIata)) return 0;

	const owned = await db.gate_ownership.where('airportIata').equals(airportIata).count();
	return Math.max(0, gatesForAirport(airportIata).length - owned);
};

/** Every stand an airline holds, ordered by airport then stand number. */
export const companyGates = async (companyId: number): Promise<OwnedGate[]> => {
	const owned = await db.gate_ownership.where('companyId').equals(companyId).toArray();

	return owned
		.map((row) => {
			const blueprint = gateBlueprint(row.gateKey);
			return blueprint ? toOwnedGate(blueprint, row) : null;
		})
		.filter((gate): gate is OwnedGate => gate !== null)
		.sort(
			(left, right) =>
				left.airportIata.localeCompare(right.airportIata) ||
				left.number.localeCompare(right.number)
		);
};

export const companyGateCount = async (companyId: number): Promise<number> =>
	db.gate_ownership.where('companyId').equals(companyId).count();

/** The stand a key names together with its holder, or null when nobody owns it. */
export const ownedGate = async (key: string): Promise<OwnedGate | null> => {
	const blueprint = gateBlueprint(key);
	if (!blueprint) return null;

	const ownership = await db.gate_ownership.get(key);
	return ownership ? toOwnedGate(blueprint, ownership) : null;
};

/** An airline's stands at one airport, used when picking a route's origin. */
export const companyGatesAt = async (
	companyId: number,
	airportIata: string
): Promise<OwnedGate[]> => {
	const owned = await db.gate_ownership
		.where('[companyId+airportIata]')
		.equals([companyId, airportIata])
		.toArray();

	return owned
		.map((row) => {
			const blueprint = gateBlueprint(row.gateKey);
			return blueprint ? toOwnedGate(blueprint, row) : null;
		})
		.filter((gate): gate is OwnedGate => gate !== null);
};

/* -------------------------------------------------------------------- aircraft */

const REGISTRATION_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export const generateRegistration = (icao: string, sequence: number): string => {
	const first = REGISTRATION_LETTERS[sequence % REGISTRATION_LETTERS.length];
	const second = REGISTRATION_LETTERS[Math.floor(sequence / REGISTRATION_LETTERS.length) % 24];
	return `${icao.slice(0, 2)}-${first}${second}${(sequence % 10).toString()}`;
};

export interface AcquireAircraftInput {
	companyId: number;
	modelId: number;
	name: string;
	seats: SeatConfig;
	ownership: 'owned' | 'leased';
	homeGateId: string;
}

export const DELIVERY_MAX_MINUTES = 60;

/**
 * Buys or leases an airframe. The very first aircraft of a company is delivered
 * instantly; every later one takes up to an hour.
 */
export const acquireAircraft = async (input: AcquireAircraftInput): Promise<Aircraft> => {
	const company = await requireCompany(input.companyId);
	const model = getModel(input.modelId);
	const gate = await ownedGate(input.homeGateId);

	if (!gate) throw new GameError('Home gate not found');
	if (gate.companyId !== input.companyId) throw new GameError('That gate is not yours');
	if (model.category > gate.maxCategory) {
		throw new GameError(
			`Gate ${gate.number} only accepts category ${gate.maxCategory} or lower (this aircraft is category ${model.category})`
		);
	}
	// A freighter's hold is fixed, so its cabin must be empty; a passenger type must
	// seat somebody and must not overflow its airframe.
	if (!seatConfigFits(input.seats, model)) {
		throw new GameError(
			model.kind === 'cargo'
				? 'A freighter carries freight, not passengers'
				: 'Configure at least one seat, and no more than the airframe holds'
		);
	}

	const now = gameNow();
	const isFirst = company.firstAircraftDelivered === 0;
	const deliveryMinutes = isFirst ? 0 : liveRandomIntBetween(1, DELIVERY_MAX_MINUTES);
	const deliveryAt = now + deliveryMinutes * 60_000;

	if (input.ownership === 'owned') {
		await postTransaction(
			input.companyId,
			'aircraft_purchase',
			-model.price,
			`Purchase ${model.name} “${input.name}”`,
			{ refId: `model:${model.id}` }
		);
	} else {
		await postTransaction(
			input.companyId,
			'aircraft_lease_deposit',
			-model.leaseDeposit,
			`Lease deposit ${model.name} “${input.name}”`,
			{ refId: `model:${model.id}` }
		);
	}

	const sequence = await db.aircraft.where('companyId').equals(input.companyId).count();
	const seats = plainAmounts(input.seats);
	const aircraftId = await db.aircraft.add({
		companyId: input.companyId,
		modelId: input.modelId,
		name: input.name.trim(),
		registration: generateRegistration(company.icao, sequence),
		ownership: input.ownership,
		leaseDailyRate: input.ownership === 'leased' ? model.leaseDailyRate : 0,
		seats,
		status: isFirst ? 'idle' : 'delivering',
		orderedAt: now,
		deliveryAt,
		homeGateId: input.homeGateId,
		currentIata: gate.airportIata,
		totalKm: 0,
		kmSinceMaintenance: 0,
		maintenanceUntil: null,
		purchasePrice: input.ownership === 'owned' ? model.price : 0,
		createdAt: now
	});

	await adjustWorkers(input.companyId, model.employees);
	if (isFirst) await db.companies.update(input.companyId, { firstAircraftDelivered: 1 });

	const aircraft = await db.aircraft.get(aircraftId);
	if (!aircraft) throw new GameError('Aircraft could not be created');
	return aircraft;
};

export const renameAircraft = async (aircraftId: number, name: string): Promise<void> => {
	await db.aircraft.update(aircraftId, { name: name.trim() });
};

export const reconfigureSeats = async (aircraftId: number, seats: SeatConfig): Promise<void> => {
	const aircraft = await db.aircraft.get(aircraftId);
	if (!aircraft) throw new GameError('Aircraft not found');
	if (aircraft.status === 'flying') throw new GameError('Cannot refit an aircraft in the air');

	await db.aircraft.update(aircraftId, { seats: plainAmounts(seats) });
};

/**
 * Sells an owned airframe back to the market, or hands a leased one back. Either
 * way its crew leaves the payroll and its schedule is dropped.
 */
export const disposeAircraft = async (aircraftId: number): Promise<number> => {
	const aircraft = await db.aircraft.get(aircraftId);
	if (!aircraft) throw new GameError('Aircraft not found');
	if (aircraft.status === 'flying') throw new GameError('Wait until the aircraft has landed');

	const model = getModel(aircraft.modelId);
	const proceeds = aircraft.ownership === 'owned' ? aircraftResaleValue(aircraft) : 0;

	if (proceeds > 0) {
		await postTransaction(
			aircraft.companyId,
			'aircraft_sale',
			proceeds,
			`Sold ${model.name} “${aircraft.name}”`,
			{ refId: `aircraft:${aircraftId}` }
		);
	}

	await db.schedule_entries.where('aircraftId').equals(aircraftId).delete();
	await db.aircraft.delete(aircraftId);
	await adjustWorkers(aircraft.companyId, -model.employees);

	return proceeds;
};

/**
 * Takes an aircraft out of service for a heavy check. The player decides when:
 * flying past the interval is allowed, it just raises the accident risk.
 */
export const sendToMaintenance = async (aircraftId: number): Promise<void> => {
	const aircraft = await db.aircraft.get(aircraftId);
	if (!aircraft) throw new GameError('Aircraft not found');
	if (aircraft.status === 'flying') throw new GameError('Wait until the aircraft has landed');
	if (aircraft.status === 'maintenance') throw new GameError('It is already in the hangar');
	if (aircraft.status === 'delivering') throw new GameError('It has not been delivered yet');

	await startMaintenance(aircraft, gameNow());
};

export const companyFleet = async (companyId: number): Promise<Aircraft[]> => {
	const fleet = await db.aircraft.where('companyId').equals(companyId).toArray();
	return fleet.sort((left, right) => left.createdAt - right.createdAt);
};

/* ---------------------------------------------------------------------- routes */

export interface RoutePreview {
	fromGateId: string;
	toGateId: string;
	fromIata: string;
	toIata: string;
	distanceKm: number;
	setupCost: number;
	destinationGateOwned: boolean;
	pairKey: string;
	alreadyOperated: boolean;
}

export const previewRoute = async (
	companyId: number,
	fromGateId: string,
	toGateId: string
): Promise<RoutePreview> => {
	const fromGate = gateBlueprint(fromGateId);
	const toGate = gateBlueprint(toGateId);
	if (!fromGate || !toGate) throw new GameError('Gate not found');
	if (fromGate.airportIata === toGate.airportIata) {
		throw new GameError('Origin and destination must differ');
	}

	const [fromOwner, toOwner] = await Promise.all([
		db.gate_ownership.get(fromGateId),
		db.gate_ownership.get(toGateId)
	]);

	if (fromOwner?.companyId !== companyId) throw new GameError('The origin gate must be yours');

	const from = getAirport(fromGate.airportIata);
	const to = getAirport(toGate.airportIata);
	const destinationGateOwned = toOwner?.companyId === companyId;

	if (toOwner && !destinationGateOwned) {
		throw new GameError('That destination gate belongs to another airline');
	}

	// A route is a link flown in both directions, so an existing route on this pair
	// counts as already operated whichever way round it was set up.
	const pairKey = pairKeyOf(fromGate.airportIata, toGate.airportIata);
	const existing = await db.routes
		.where('companyId')
		.equals(companyId)
		.filter((route) => pairKeyOf(route.fromIata, route.toIata) === pairKey)
		.first();

	return {
		fromGateId,
		toGateId,
		fromIata: fromGate.airportIata,
		toIata: toGate.airportIata,
		distanceKm: Math.round(distanceKm(from, to)),
		setupCost: destinationGateOwned ? 0 : toGate.price,
		destinationGateOwned,
		pairKey,
		alreadyOperated: Boolean(existing)
	};
};

export const createRoute = async (
	companyId: number,
	fromGateId: string,
	toGateId: string,
	prices: ClassAmounts
): Promise<Route> => {
	const preview = await previewRoute(companyId, fromGateId, toGateId);
	if (preview.alreadyOperated) throw new GameError('You already operate this route');

	if (!preview.destinationGateOwned) {
		await buyGate(companyId, toGateId);
	}

	const routeId = await db.routes.add({
		companyId,
		fromGateId,
		toGateId,
		fromIata: preview.fromIata,
		toIata: preview.toIata,
		distanceKm: preview.distanceKm,
		prices: plainAmounts(prices),
		cargoRatePerTonne: idealCargoRate(preview.distanceKm),
		createdAt: gameNow()
	});

	await adjustWorkers(companyId, EMPLOYEES_PER_ROUTE);

	const route = await db.routes.get(routeId);
	if (!route) throw new GameError('Route could not be created');
	return route;
};

export const updateRoutePrices = async (routeId: number, prices: ClassAmounts): Promise<void> => {
	await db.routes.update(routeId, { prices: plainAmounts(prices) });
};

/** What the airline charges per tonne of freight on a link. */
export const updateCargoRate = async (routeId: number, ratePerTonne: number): Promise<void> => {
	await db.routes.update(routeId, { cargoRatePerTonne: Math.max(0, Math.round(ratePerTonne)) });
};

export const deleteRoute = async (routeId: number): Promise<void> => {
	const route = await db.routes.get(routeId);
	if (!route) return;

	await db.schedule_entries.where('routeId').equals(routeId).delete();
	await db.routes.delete(routeId);
	await adjustWorkers(route.companyId, -EMPLOYEES_PER_ROUTE);
};

export const companyRoutes = async (companyId: number): Promise<Route[]> => {
	const routes = await db.routes.where('companyId').equals(companyId).toArray();
	return routes.sort((left, right) => left.createdAt - right.createdAt);
};

/* ----------------------------------------------------------------- route audit */

export const hasAudit = async (companyId: number, pairKey: string): Promise<boolean> => {
	const audit = await db.route_audits.where('[companyId+pairKey]').equals([companyId, pairKey]).first();
	return Boolean(audit);
};

export const buyAudit = async (
	companyId: number,
	pairKey: string,
	cost: number
): Promise<void> => {
	if (await hasAudit(companyId, pairKey)) return;

	await postTransaction(companyId, 'route_audit', -cost, `Market audit ${pairKey}`, {
		refId: `audit:${pairKey}`
	});
	await db.route_audits.add({ companyId, pairKey, cost, purchasedAt: gameNow() });
};

/* -------------------------------------------------------------------- schedule */

export const scheduleForAircraft = async (aircraftId: number) => {
	const entries = await db.schedule_entries.where('aircraftId').equals(aircraftId).toArray();
	return entries.sort(
		(left, right) => left.dayOfWeek - right.dayOfWeek || left.startHour - right.startHour
	);
};

export const scheduleOverlaps = (
	entries: { dayOfWeek: number; startHour: number; blockHours: number }[],
	candidate: { dayOfWeek: number; startHour: number; blockHours: number },
	ignoreIndex = -1
): boolean =>
	entries.some((entry, index) => {
		if (index === ignoreIndex) return false;
		if (entry.dayOfWeek !== candidate.dayOfWeek) return false;
		return (
			candidate.startHour < entry.startHour + entry.blockHours &&
			entry.startHour < candidate.startHour + candidate.blockHours
		);
	});

export const addScheduleEntry = async (
	companyId: number,
	aircraftId: number,
	routeId: number,
	dayOfWeek: number,
	startHour: number
): Promise<void> => {
	const [aircraft, route] = await Promise.all([db.aircraft.get(aircraftId), db.routes.get(routeId)]);
	if (!aircraft || !route) throw new GameError('Aircraft or route not found');

	const model = getModel(aircraft.modelId);
	if (route.distanceKm > model.range) {
		throw new GameError(
			`${model.name} cannot reach ${route.toIata}: ${route.distanceKm} km exceeds its ${model.range} km range`
		);
	}

	const blockHours = blockHoursSlots(model, route.distanceKm);
	if (startHour + blockHours > 24) throw new GameError('That leg does not fit before midnight');

	const existing = await scheduleForAircraft(aircraftId);
	if (scheduleOverlaps(existing, { dayOfWeek, startHour, blockHours })) {
		throw new GameError('That slot overlaps another leg');
	}

	await db.schedule_entries.add({
		companyId,
		aircraftId,
		routeId,
		dayOfWeek,
		startHour,
		blockHours,
		createdAt: gameNow()
	});
};

export const removeScheduleEntry = async (entryId: number): Promise<void> => {
	await db.schedule_entries.delete(entryId);
};

/**
 * Repeats one day's rotation across the rest of the week, replacing whatever those
 * days held. The source day is already a valid, non-overlapping pattern, so the
 * copies are too.
 */
export const copyScheduleDay = async (
	aircraftId: number,
	sourceDayOfWeek: number
): Promise<number> => {
	const entries = await db.schedule_entries.where('aircraftId').equals(aircraftId).toArray();
	const template = entries.filter((entry) => entry.dayOfWeek === sourceDayOfWeek);

	if (template.length === 0) {
		throw new GameError(`Nothing is scheduled on ${DAY_NAMES_LONG[sourceDayOfWeek]} to copy`);
	}

	const stale = entries.filter((entry) => entry.dayOfWeek !== sourceDayOfWeek);
	await db.schedule_entries.bulkDelete(stale.map((entry) => entry.id));

	const now = gameNow();
	const copies = [];
	for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
		if (dayOfWeek === sourceDayOfWeek) continue;

		for (const entry of template) {
			copies.push({
				companyId: entry.companyId,
				aircraftId: entry.aircraftId,
				routeId: entry.routeId,
				dayOfWeek,
				startHour: entry.startHour,
				blockHours: entry.blockHours,
				createdAt: now
			});
		}
	}

	await db.schedule_entries.bulkAdd(copies);
	return copies.length;
};

/** Clears an aircraft's whole week. */
export const clearSchedule = async (aircraftId: number): Promise<number> => {
	const entries = await db.schedule_entries.where('aircraftId').equals(aircraftId).toArray();
	await db.schedule_entries.bulkDelete(entries.map((entry) => entry.id));
	return entries.length;
};

/* --------------------------------------------------------------------- workers */

export const hireWorkers = async (companyId: number, workers: number): Promise<void> => {
	const company = await requireCompany(companyId);
	const toHire = Math.min(workers, company.external_workers);
	if (toHire <= 0) throw new GameError('No external workers to hire');

	const cost = hiringCost(toHire);
	await postTransaction(
		companyId,
		'hiring_fee',
		-cost,
		`Hired ${toHire} external worker${toHire === 1 ? '' : 's'}`
	);

	await db.companies.update(companyId, {
		external_workers: company.external_workers - toHire,
		hired_workers: company.hired_workers + toHire
	});
};

/* ---------------------------------------------------------------------- shares */

export const sharesHeldBy = async (companyId: number, holderId: string): Promise<number> => {
	const holding = await db.shareholdings
		.where('[companyId+holderId]')
		.equals([companyId, holderId])
		.first();
	return holding?.quantity ?? 0;
};

export interface ShareholderRow {
	holderId: string;
	name: string;
	quantity: number;
	isViewer: boolean;
	/** The airline holding its own float, which is what it sells to raise cash. */
	isTreasury: boolean;
	controls: boolean;
}

/** Display name for a holder id: the player, a desk, an airline, or the raw id. */
const holderName = async (holderId: string, targetCompanyId: number): Promise<string> => {
	if (holderId === PLAYER_HOLDER_ID) return 'You';

	const deskId = holderBrokerId(holderId);
	if (deskId !== null) {
		const desk = await db.brokers.get(deskId);
		return desk ? desk.name : holderId;
	}

	const ownerId = holderCompanyId(holderId);
	if (ownerId === null) return holderId;
	if (ownerId === targetCompanyId) return 'Own treasury';

	const owner = await db.companies.get(ownerId);
	return owner ? `${owner.icao} · ${owner.name}` : holderId;
};

/** Who holds an airline's float, largest holder first. */
export const shareRegister = async (
	companyId: number,
	viewerHolderId: string
): Promise<ShareholderRow[]> => {
	const holdings = await db.shareholdings.where('companyId').equals(companyId).toArray();

	const rows = await Promise.all(
		holdings
			.filter((holding) => holding.quantity > 0)
			.map(async (holding) => ({
				holderId: holding.holderId,
				name: await holderName(holding.holderId, companyId),
				quantity: holding.quantity,
				isViewer: holding.holderId === viewerHolderId,
				isTreasury: holderCompanyId(holding.holderId) === companyId,
				controls: holding.quantity > CONTROL_THRESHOLD
			}))
	);

	return rows.sort((left, right) => right.quantity - left.quantity);
};

const setShares = async (companyId: number, holderId: string, quantity: number): Promise<void> => {
	const holding = await db.shareholdings
		.where('[companyId+holderId]')
		.equals([companyId, holderId])
		.first();

	if (!holding) {
		if (quantity > 0) await db.shareholdings.add({ companyId, holderId, quantity });
		return;
	}

	if (quantity <= 0) {
		await db.shareholdings.delete(holding.id!);
		return;
	}

	await db.shareholdings.update(holding.id!, { quantity });
};

export const moveShares = async (
	companyId: number,
	fromHolderId: string,
	toHolderId: string,
	quantity: number
): Promise<void> => {
	const fromQuantity = await sharesHeldBy(companyId, fromHolderId);
	if (fromQuantity < quantity) throw new GameError('Seller does not hold that many shares');

	const toQuantity = await sharesHeldBy(companyId, toHolderId);
	await setShares(companyId, fromHolderId, fromQuantity - quantity);
	await setShares(companyId, toHolderId, toQuantity + quantity);
};

/**
 * A holder past 50% controls the airline; the player taking control stops its AI, and the
 * player losing control also dismisses any chief executive they had hired — their fee comes
 * out of a stake that is no longer a majority, and the airline's own people take over.
 *
 * Every route to losing control funnels through here, not just the CEO's own fee: selling a
 * block on the market settles into this function too, and a CEO left hired would keep
 * drawing a share a day from somebody who no longer owns the airline.
 */
export const refreshControl = async (companyId: number): Promise<void> => {
	const company = await requireCompany(companyId);
	const playerShares = await sharesHeldBy(companyId, PLAYER_HOLDER_ID);
	const controller = playerShares > CONTROL_THRESHOLD ? 'player' : 'ai';

	// Built as a patch rather than returned early on an unchanged controller, because a row
	// that is already 'ai' can still be carrying a hired CEO that has to go.
	const patch: Partial<Company> = {};
	if (controller !== company.controller) patch.controller = controller;
	if (controller === 'ai' && (company.ceoHired ?? false)) patch.ceoHired = false;
	if (Object.keys(patch).length === 0) return;

	await db.companies.update(companyId, patch);
};

/* ---------------------------------------------------------------- chief executive */

/**
 * Engages a chief executive: from tomorrow the airline's daily decisions are the AI's, its
 * overdue airframes go in for their checks unasked, and the fee is one of the player's shares
 * a day.
 *
 * Control is read off the register rather than `controller`, which is only refreshed when a
 * listing settles and can therefore be a day stale.
 */
export const hireCeo = async (companyId: number): Promise<void> => {
	const company = await requireCompany(companyId);
	if (company.ceoHired ?? false) {
		throw new GameError('A chief executive already runs this airline');
	}

	const held = await sharesHeldBy(companyId, PLAYER_HOLDER_ID);
	if (held <= CONTROL_THRESHOLD) throw new GameError('You do not control this airline');

	// Today's decisions and charges have already happened, so the fee starts tomorrow.
	await db.companies.update(companyId, { ceoHired: true, lastCeoDay: dayIndexOf(gameNow()) });
};

/**
 * Dismisses the chief executive. Nothing to settle: the fee is paid in arrears, one share per
 * closed day, so no share is ever owed and none is ever refunded. `lastCeoDay` is left where
 * it is — it is only read while a CEO is hired, and hiring again overwrites it.
 */
export const fireCeo = async (companyId: number): Promise<void> => {
	const company = await requireCompany(companyId);
	if (!(company.ceoHired ?? false)) throw new GameError('No chief executive to dismiss');

	await db.companies.update(companyId, { ceoHired: false });
};

/**
 * Puts shares on the market. `proceedsCompanyId` names the wallet to pay when they sell,
 * and is only needed for a seller whose holder id has no wallet of its own — the player,
 * who holds shares personally but banks through an airline.
 */
export const listSharesForSale = async (
	companyId: number,
	sellerId: string,
	quantity: number,
	pricePerShare: number,
	proceedsCompanyId?: number
): Promise<void> => {
	const held = await sharesHeldBy(companyId, sellerId);
	const alreadyListed = (await db.share_listings.where('companyId').equals(companyId).toArray())
		.filter((listing) => listing.sellerId === sellerId)
		.reduce((sum, listing) => sum + listing.quantity, 0);

	if (held - alreadyListed < quantity) throw new GameError('Not enough unlisted shares');

	await db.share_listings.add({
		companyId,
		sellerId,
		quantity,
		pricePerShare,
		createdAt: gameNow(),
		proceedsCompanyId
	});
};

export const cancelListing = async (listingId: number): Promise<void> => {
	await db.share_listings.delete(listingId);
};

const requireFillableListing = async (
	listingId: number,
	buyerHolderId: string,
	quantity: number
): Promise<ShareListing> => {
	const listing = await db.share_listings.get(listingId);
	if (!listing) throw new GameError('Listing no longer available');
	if (quantity <= 0 || quantity > listing.quantity) throw new GameError('Invalid quantity');
	if (listing.sellerId === buyerHolderId) throw new GameError('You already own those shares');

	return listing;
};

/**
 * Settles a fill: pays the seller, moves the shares, shrinks the book, records the trade.
 * Charging the buyer is the caller's business, because not every buyer has a balance sheet
 * to charge — a broker desk has unlimited money and no wallet at all.
 *
 * A seller with no wallet to credit is paid nothing, and the money simply leaves the world.
 * That is only ever a broker desk, which has no use for proceeds; an airline is found from
 * its holder id and the player names their airline on the listing.
 */
const settleListingFill = async (
	listing: ShareListing,
	buyerHolderId: string,
	quantity: number
): Promise<void> => {
	const total = quantity * listing.pricePerShare;
	const target = await requireCompany(listing.companyId);
	const payee = holderCompanyId(listing.sellerId) ?? listing.proceedsCompanyId ?? null;

	if (payee !== null) {
		await postTransaction(
			payee,
			'share_sale',
			total,
			`Sold ${quantity} ${target.icao} share${quantity === 1 ? '' : 's'} at ${listing.pricePerShare} €`,
			{ refId: `shares:${listing.companyId}` }
		);
	}

	await moveShares(listing.companyId, listing.sellerId, buyerHolderId, quantity);

	if (quantity === listing.quantity) {
		await db.share_listings.delete(listing.id);
	} else {
		await db.share_listings.update(listing.id, { quantity: listing.quantity - quantity });
	}

	await db.share_trades.add({
		companyId: listing.companyId,
		at: gameNow(),
		buyerId: buyerHolderId,
		sellerId: listing.sellerId,
		quantity,
		pricePerShare: listing.pricePerShare
	});

	await refreshControl(listing.companyId);
};

/**
 * Buys shares off a listing. The buyer pays cash; a selling airline receives it,
 * while the player's own wallet is the buying company's cash.
 */
export const buyListedShares = async (
	listingId: number,
	buyerHolderId: string,
	buyerCompanyId: number,
	quantity: number
): Promise<void> => {
	const listing = await requireFillableListing(listingId, buyerHolderId, quantity);
	const total = quantity * listing.pricePerShare;
	const target = await requireCompany(listing.companyId);

	// Debited before anything moves, so a buyer who cannot afford it changes nothing.
	await postTransaction(
		buyerCompanyId,
		'share_purchase',
		-total,
		`Bought ${quantity} ${target.icao} share${quantity === 1 ? '' : 's'} at ${listing.pricePerShare} €`,
		{ refId: `shares:${listing.companyId}` }
	);

	await settleListingFill(listing, buyerHolderId, quantity);
};

/**
 * A broker desk filling an ask. There is no buyer cash leg — desks have effectively
 * unlimited money — but the seller is still paid, which is the whole point of the feature:
 * a floated share becomes real cash for the carrier that floated it.
 */
export const fillListingAsBroker = async (
	listingId: number,
	brokerHolderId: string,
	quantity: number
): Promise<void> => {
	if (holderBrokerId(brokerHolderId) === null) throw new GameError('Not a broker');

	const listing = await requireFillableListing(listingId, brokerHolderId, quantity);
	const held = await sharesHeldBy(listing.companyId, brokerHolderId);

	// A desk never takes control. Stopping at half the float also leaves the cheap end of
	// the book on the market instead of clearing it out from under the player.
	if (held + quantity > CONTROL_THRESHOLD) throw new GameError('Broker holding cap reached');

	await settleListingFill(listing, brokerHolderId, quantity);
};

/* -------------------------------------------------------------- takeover bids */

export interface OpenBidInput {
	targetCompanyId: number;
	bidderHolderId: string;
	bidderCompanyId: number;
	pricePerShare: number;
	sharesSought: number;
	closesDay: number;
}

/**
 * Opens a bid and escrows the money for it in one go.
 *
 * The row goes in first and the debit second — the opposite of `buyListedShares`, which
 * debits before it moves anything — because the ledger line has to name the bid it belongs
 * to, and the id only exists once the row is written. Both writes sit inside one Dexie
 * transaction so that a bidder who cannot afford the escrow is left with no bid at all:
 * this is the one place in the feature where a half-written state would take a player's cash
 * and give them nothing, which is why it is also the only gameplay write here that needs a
 * transaction rather than careful ordering.
 */
export const openTakeoverBid = async (input: OpenBidInput): Promise<TakeoverBid> => {
	const target = await requireCompany(input.targetCompanyId);
	await requireCompany(input.bidderCompanyId);

	if (input.sharesSought <= 0) throw new GameError('Nothing to bid for');
	if (input.pricePerShare <= 0) throw new GameError('Offer price must be positive');

	const held = await sharesHeldBy(input.targetCompanyId, input.bidderHolderId);
	if (held > CONTROL_THRESHOLD) throw new GameError('You already control this airline');
	if (input.targetCompanyId === input.bidderCompanyId) {
		throw new GameError('An airline cannot bid for itself');
	}

	const standing = await openBidFor(input.targetCompanyId);
	if (standing) throw new GameError('There is already an offer open for this airline');

	const lockout = target.bidLockoutUntilDay ?? null;
	if (lockout !== null && dayIndexOf(gameNow()) < lockout) {
		throw new GameError('The board has barred a fresh offer');
	}

	const at = gameNow();
	const escrow = input.sharesSought * input.pricePerShare;

	return db.transaction('rw', db.takeover_bids, db.companies, db.transaction_records, async () => {
		const id = await db.takeover_bids.add({
			targetCompanyId: input.targetCompanyId,
			bidderHolderId: input.bidderHolderId,
			bidderCompanyId: input.bidderCompanyId,
			pricePerShare: input.pricePerShare,
			sharesSought: input.sharesSought,
			escrow,
			openedAt: at,
			openedDay: dayIndexOf(at),
			closesDay: input.closesDay,
			status: 'open',
			sharesTendered: 0,
			resolvedAt: null,
			defence: null
		} as TakeoverBid);

		await postTransaction(
			input.bidderCompanyId,
			'share_purchase',
			-escrow,
			`Escrow for offer of ${input.sharesSought} ${target.icao} shares at ${input.pricePerShare} €`,
			{ at, refId: `bid:${id}` }
		);

		return (await db.takeover_bids.get(id))!;
	});
};

/** The offer standing against an airline, if any. One at a time, so at most one row. */
export const openBidFor = async (
	targetCompanyId: number,
	bidderHolderId?: string
): Promise<TakeoverBid | null> => {
	const open = await db.takeover_bids
		.where('[targetCompanyId+status]')
		.equals([targetCompanyId, 'open'])
		.toArray();

	const match = bidderHolderId
		? open.find((bid) => bid.bidderHolderId === bidderHolderId)
		: open[0];

	return match ?? null;
};

/**
 * Every bid whose window has run out. Due-based rather than exact, because `catchUp` can jump
 * a whole span of days at once: a bid whose closing day fell inside the gap has to resolve at
 * the next close, not sit open forever with the player's cash escrowed.
 */
export const bidsDueBy = async (dayIndex: number): Promise<TakeoverBid[]> =>
	(await db.takeover_bids.where('status').equals('open').toArray())
		.filter((bid) => bid.closesDay <= dayIndex)
		.sort((left, right) => left.id - right.id);

export const openBids = async (): Promise<TakeoverBid[]> =>
	(await db.takeover_bids.where('status').equals('open').toArray()).sort(
		(left, right) => left.id - right.id
	);

export const recordBidDefence = async (bidId: number, defence: string): Promise<void> => {
	await db.takeover_bids.update(bidId, { defence });
};

export const setBidLockout = async (companyId: number, untilDay: number): Promise<void> => {
	await db.companies.update(companyId, { bidLockoutUntilDay: untilDay });
};

/**
 * Moves one holder's shares into the bid and pays them, returning the cash actually spent.
 *
 * Re-reads the holding rather than trusting the judgement it was handed: days pass between a
 * bid opening and closing, and the register moves in between. The listings step is the subtle
 * one — a holder may have promised part of its stake to the order book, and
 * `listSharesForSale` only checks that at listing time, so shares sold into a bid would
 * otherwise leave an ask behind that the holder can no longer honour. The register-total
 * invariant does not catch that, because the totals stay right; only the book is wrong.
 */
export const settleBidTender = async (
	bid: TakeoverBid,
	holderId: string,
	quantity: number
): Promise<number> => {
	if (holderId === bid.bidderHolderId) return 0;

	const held = await sharesHeldBy(bid.targetCompanyId, holderId);
	const moving = Math.min(quantity, held);
	if (moving <= 0) return 0;

	const target = await requireCompany(bid.targetCompanyId);
	const total = moving * bid.pricePerShare;
	const remainingHeld = held - moving;

	const asks = (await db.share_listings.where('companyId').equals(bid.targetCompanyId).toArray())
		.filter((listing) => listing.sellerId === holderId)
		.sort((left, right) => right.pricePerShare - left.pricePerShare);

	// Trim the dearest asks first, so whatever the holder keeps on the market is the cheap end
	// a buyer was most likely watching.
	let listed = asks.reduce((sum, listing) => sum + listing.quantity, 0);
	for (const ask of asks) {
		if (listed <= remainingHeld) break;
		const excess = listed - remainingHeld;

		if (excess >= ask.quantity) {
			await db.share_listings.delete(ask.id);
			listed -= ask.quantity;
			continue;
		}

		await db.share_listings.update(ask.id, { quantity: ask.quantity - excess });
		listed -= excess;
	}

	// A desk has no balance sheet to pay into, so its shares are bought and the money simply
	// leaves the world — the same rule `settleListingFill` follows and documents.
	const payee = holderCompanyId(holderId);
	if (payee !== null) {
		await postTransaction(
			payee,
			'share_sale',
			total,
			`Tendered ${moving} ${target.icao} share${moving === 1 ? '' : 's'} at ${bid.pricePerShare} €`,
			{ refId: `bid:${bid.id}` }
		);
	}

	await moveShares(bid.targetCompanyId, holderId, bid.bidderHolderId, moving);

	await db.share_trades.add({
		companyId: bid.targetCompanyId,
		at: gameNow(),
		buyerId: bid.bidderHolderId,
		sellerId: holderId,
		quantity: moving,
		pricePerShare: bid.pricePerShare
	});

	return total;
};

/**
 * Closes a bid out: refunds what the escrow did not spend and stamps the outcome. Control is
 * refreshed here rather than per tender, because one bid can carry a bidder from nothing to
 * the whole airline and control should change once, at the end, not part-way through a loop.
 */
export const closeTakeoverBid = async (
	bid: TakeoverBid,
	status: BidStatus,
	sharesTendered: number,
	refund: number,
	defence: string | null = null
): Promise<void> => {
	const at = gameNow();

	if (refund > 0) {
		const target = await db.companies.get(bid.targetCompanyId);
		await postTransaction(
			bid.bidderCompanyId,
			'share_purchase',
			refund,
			`Escrow returned from offer for ${target?.icao ?? 'airline'}`,
			{ at, refId: `bid:${bid.id}` }
		);
	}

	await db.takeover_bids.update(bid.id, {
		status,
		sharesTendered,
		resolvedAt: at,
		defence: defence ?? bid.defence
	});

	await refreshControl(bid.targetCompanyId);
};

/** Pulls an offer before it closes. The refund is the caller's to work out. */
export const withdrawTakeoverBid = async (bidId: number): Promise<TakeoverBid> => {
	const bid = await db.takeover_bids.get(bidId);
	if (!bid) throw new GameError('That offer is no longer open');
	if (bid.status !== 'open') throw new GameError('That offer has already closed');

	return bid;
};

/**
 * A board buying its own float back off the open book, into its treasury. Every share it
 * recovers is a share behind its own reservation price instead of a bidder's for the taking —
 * and it costs the board cash it wanted for aircraft, which is the point.
 */
export const buyBackOwnFloat = async (
	companyId: number,
	maxShares: number,
	maxPricePerShare: number
): Promise<number> => {
	const holderId = companyHolderId(companyId);
	const asks = (await db.share_listings.where('companyId').equals(companyId).toArray())
		.filter((listing) => listing.sellerId !== holderId && listing.pricePerShare <= maxPricePerShare)
		.sort((left, right) => left.pricePerShare - right.pricePerShare);

	let bought = 0;
	for (const ask of asks) {
		if (bought >= maxShares) break;
		const take = Math.min(ask.quantity, maxShares - bought);

		try {
			await buyListedShares(ask.id, holderId, companyId, take);
			bought += take;
		} catch {
			// Out of cash, or somebody took it first. The board does what it can afford.
		}
	}

	return bought;
};

/* ------------------------------------------------------------------- incidents */

/** Repair time for an airframe written up after an accident. */
const ACCIDENT_REPAIR_HOURS = 48;

const closeIncident = async (
	incidentId: number,
	outcome: string,
	finalAmount: number
): Promise<void> => {
	const incident = await db.incidents.get(incidentId);
	if (!incident) return;

	await db.incidents.update(incidentId, {
		status: finalAmount > 0 ? 'settled' : 'litigated',
		outcome,
		finalAmount,
		resolvedAt: gameNow()
	});

	// The aircraft goes in for repairs, then rejoins the fleet with a clean sheet.
	await db.aircraft.update(incident.aircraftId, {
		status: 'maintenance',
		maintenanceUntil: gameNow() + ACCIDENT_REPAIR_HOURS * 3_600_000,
		kmSinceMaintenance: 0
	});
};

/** Pay the claim straight away, no court. */
export const settleIncident = async (incidentId: number): Promise<void> => {
	const incident = await db.incidents.get(incidentId);
	if (!incident) throw new GameError('Incident not found');
	if (incident.status !== 'pending') throw new GameError('That claim is already closed');

	await postTransaction(
		incident.companyId,
		'incident_settlement',
		-incident.baseAmount,
		`Indemnity paid for accident of ${incident.aircraftName}`,
		{ allowOverdraft: true, refId: `incident:${incidentId}` }
	);

	await closeIncident(incidentId, 'Settled out of court', incident.baseAmount);
};

/**
 * Take the claim to court. A coin flip: win and pay nothing, lose and pay the
 * damages plus a 10%–100% penalty.
 */
export const fightIncident = async (incidentId: number): Promise<LawsuitOutcome> => {
	const incident = await db.incidents.get(incidentId);
	if (!incident) throw new GameError('Incident not found');
	if (incident.status !== 'pending') throw new GameError('That claim is already closed');

	const outcome = resolveLawsuit(incident.baseAmount, Math.random(), Math.random());

	if (!outcome.won) {
		await postTransaction(
			incident.companyId,
			'incident_lawsuit',
			-outcome.amount,
			`${outcome.description} — ${incident.aircraftName}`,
			{ allowOverdraft: true, refId: `incident:${incidentId}` }
		);
	}

	await closeIncident(incidentId, outcome.description, outcome.amount);
	return outcome;
};

export const pendingIncidents = async (companyId: number) => {
	const incidents = await db.incidents
		.where('[companyId+status]')
		.equals([companyId, 'pending'])
		.toArray();
	return incidents.sort((left, right) => right.at - left.at);
};

export const incidentHistory = async (companyId: number) => {
	const incidents = await db.incidents.where('companyId').equals(companyId).toArray();
	return incidents
		.filter((incident) => incident.status !== 'pending')
		.sort((left, right) => right.at - left.at);
};

/* ------------------------------------------------------------------ accounting */

export const recentTransactions = async (companyId: number, limit = 400) => {
	const records = await db.transaction_records.where('companyId').equals(companyId).toArray();
	return records.sort((left, right) => right.at - left.at).slice(0, limit);
};

/**
 * Every ledger row inside a span of game days, newest first. Unlike `recentTransactions`
 * this never truncates, which matters when a window is being totalled rather than listed:
 * a busy airline would otherwise lose its oldest days to the row limit and report a
 * flattering result. Rides the `[companyId+day]` index, so a four-week window never has
 * to load the whole ledger.
 */
export const transactionsBetweenDays = async (
	companyId: number,
	fromDay: number,
	toDay: number
): Promise<TransactionRecord[]> => {
	const records = await db.transaction_records
		.where('[companyId+day]')
		.between([companyId, fromDay], [companyId, toDay], true, true)
		.toArray();

	return records.sort((left, right) => right.at - left.at);
};

/** What people actually paid for an airline's shares, newest first. */
export const recentShareTrades = async (companyId: number, limit = 20): Promise<ShareTrade[]> => {
	const trades = await db.share_trades.where('companyId').equals(companyId).toArray();
	return trades.sort((left, right) => right.at - left.at).slice(0, limit);
};
