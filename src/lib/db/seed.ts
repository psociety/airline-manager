import { AIRCRAFT_MODELS, blockHoursSlots, defaultSeatConfig, getModel } from '$data/aircraft';
import { AIRPORTS, getAirport } from '$data/airports';
import { smallestGateForCategory } from '$data/gates';
import { BASE_FUEL_PRICE_PER_LITRE } from '$engine/economy';
import { idealCargoRate, idealPrices } from '$engine/demand';
import { distanceKm } from '$engine/geo';
import { dayIndexOf, gameNow } from '$engine/clock';
import { pickOne, randomIntBetween, seededRng } from '$engine/rng';
import { availableGatesAt, companyGates, createCompany, pickCompanyColour } from './repo';
import { EMPLOYEES_PER_GATE, EMPLOYEES_PER_ROUTE, db } from './schema';

const WORLD_SEED = 20240731;

interface AiAirlineBlueprint {
	name: string;
	icao: string;
	homeIata: string;
	cash: number;
}

/** Fictional carriers pinned to real hubs, so the world starts with competition. */
const AI_AIRLINES: AiAirlineBlueprint[] = [
	{ name: 'Northwind Airways', icao: 'NWA', homeIata: 'ORD', cash: 12_000_000 },
	{ name: 'Meridian Atlantic', icao: 'MDA', homeIata: 'JFK', cash: 10_500_000 },
	{ name: 'Albion Skyways', icao: 'ABS', homeIata: 'LHR', cash: 9_800_000 },
	{ name: 'Rhein Air', icao: 'RHN', homeIata: 'FRA', cash: 9_200_000 },
	{ name: 'Lumière Lignes', icao: 'LMR', homeIata: 'CDG', cash: 8_800_000 },
	{ name: 'Iberavia', icao: 'IBV', homeIata: 'MAD', cash: 7_000_000 },
	{ name: 'Gulf Crescent', icao: 'GCR', homeIata: 'DXB', cash: 14_000_000 },
	{ name: 'Sakura Wings', icao: 'SKW', homeIata: 'HND', cash: 9_600_000 },
	{ name: 'Dragonpath Air', icao: 'DGP', homeIata: 'HKG', cash: 8_400_000 },
	{ name: 'Southern Cross Air', icao: 'SXA', homeIata: 'SYD', cash: 6_600_000 },
	{ name: 'Andes Volar', icao: 'AVL', homeIata: 'GRU', cash: 5_800_000 },
	{ name: 'Savanna Air', icao: 'SVN', homeIata: 'JNB', cash: 5_200_000 }
];

const seedAiAirline = async (
	blueprint: AiAirlineBlueprint,
	index: number,
	dayIndex: number
): Promise<void> => {
	const rng = seededRng('seed-airline', blueprint.icao);
	const company = await createCompany({
		name: blueprint.name,
		icao: blueprint.icao,
		homeIata: blueprint.homeIata,
		controller: 'ai',
		cash: blueprint.cash,
		colour: pickCompanyColour(index + 1)
	});
	const companyId = company.id!;
	const home = getAirport(blueprint.homeIata);

	// A starter fleet the home stand can actually take.
	const homeGate = (await companyGates(companyId))[0];
	if (!homeGate) return;

	const fleetSize = randomIntBetween(rng, 2, 5);
	const affordable = AIRCRAFT_MODELS.filter(
		(model) => model.category <= homeGate.maxCategory && model.price < blueprint.cash * 0.5
	);
	if (affordable.length === 0) return;

	for (let index = 0; index < fleetSize; index += 1) {
		const model = pickOne(rng, affordable.slice(-12));
		await db.aircraft.add({
			companyId,
			modelId: model.id,
			name: `${blueprint.icao} ${model.name}`,
			registration: `${blueprint.icao.slice(0, 2)}-${String.fromCharCode(65 + index)}${randomIntBetween(rng, 10, 99)}`,
			ownership: rng() < 0.35 ? 'leased' : 'owned',
			leaseDailyRate: model.leaseDailyRate,
			seats: defaultSeatConfig(model),
			status: 'idle',
			orderedAt: gameNow(),
			deliveryAt: gameNow(),
			homeGateId: homeGate.key,
			currentIata: blueprint.homeIata,
			totalKm: randomIntBetween(rng, 0, 200_000),
			kmSinceMaintenance: randomIntBetween(rng, 0, model.maintenanceIntervalKm - 1),
			maintenanceUntil: null,
			purchasePrice: model.price,
			createdAt: gameNow()
		});

		await db.companies.update(companyId, { firstAircraftDelivered: 1 });
		const current = await db.companies.get(companyId);
		if (current) {
			await db.companies.update(companyId, {
				external_workers: current.external_workers + model.employees
			});
		}
	}

	const seededFleet = await db.aircraft.where('companyId').equals(companyId).toArray();
	const longestRange = Math.max(...seededFleet.map((aircraft) => getModel(aircraft.modelId).range));
	const heaviestCategory = Math.max(
		...seededFleet.map((aircraft) => getModel(aircraft.modelId).category)
	);

	// Two to five routes out of the hub, each with a free destination stand.
	const routeCount = randomIntBetween(rng, 2, 5);
	const destinations = AIRPORTS.filter((airport) => {
		if (airport.iataCode === blueprint.homeIata) return false;
		const distance = distanceKm(home, airport);
		return distance > 300 && distance <= longestRange;
	})
		.sort((left, right) => right.tier - left.tier)
		.slice(0, 30);

	const routeIds: number[] = [];
	for (let index = 0; index < routeCount && destinations.length > 0; index += 1) {
		const destination = pickOne(rng, destinations);
		const freeGates = await availableGatesAt(destination.iataCode);
		if (freeGates.length === 0) continue;

		// Apron sized to the fleet that will use it, not the biggest the field offers.
		const gate = smallestGateForCategory(freeGates, heaviestCategory);
		if (!gate) continue;

		const distance = Math.round(distanceKm(home, destination));
		const ideal = idealPrices(distance);

		await db.gate_ownership.add({
			gateKey: gate.key,
			airportIata: gate.airportIata,
			companyId,
			purchasedAt: gameNow()
		});

		const routeId = await db.routes.add({
			companyId,
			fromGateId: homeGate.key,
			toGateId: gate.key,
			fromIata: blueprint.homeIata,
			toIata: destination.iataCode,
			distanceKm: distance,
			prices: {
				economy: Math.round(ideal.economy * (0.9 + rng() * 0.25)),
				business: Math.round(ideal.business * (0.9 + rng() * 0.25)),
				first: Math.round(ideal.first * (0.9 + rng() * 0.25))
			},
			cargoRatePerTonne: idealCargoRate(distance),
			createdAt: gameNow()
		});
		routeIds.push(routeId);

		const current = await db.companies.get(companyId);
		if (current) {
			await db.companies.update(companyId, {
				external_workers: current.external_workers + EMPLOYEES_PER_ROUTE + EMPLOYEES_PER_GATE
			});
		}
	}

	// Give each airframe a weekly pattern so the world has traffic from minute one.
	const fleet = await db.aircraft.where('companyId').equals(companyId).toArray();
	for (const aircraft of fleet) {
		const model = getModel(aircraft.modelId);
		if (routeIds.length === 0) continue;

		const legs = randomIntBetween(rng, 3, 7);
		const taken: { dayOfWeek: number; startHour: number; blockHours: number }[] = [];

		for (let leg = 0; leg < legs; leg += 1) {
			const routeId = pickOne(rng, routeIds);
			const route = await db.routes.get(routeId);
			if (!route || route.distanceKm > model.range) continue;

			const blockHours = blockHoursSlots(model, route.distanceKm);
			const dayOfWeek = randomIntBetween(rng, 0, 6);
			const startHour = randomIntBetween(rng, 0, Math.max(0, 24 - blockHours));
			if (startHour + blockHours > 24) continue;

			const overlaps = taken.some(
				(entry) =>
					entry.dayOfWeek === dayOfWeek &&
					startHour < entry.startHour + entry.blockHours &&
					entry.startHour < startHour + blockHours
			);
			if (overlaps) continue;

			taken.push({ dayOfWeek, startHour, blockHours });
			await db.schedule_entries.add({
				companyId,
				aircraftId: aircraft.id!,
				routeId,
				dayOfWeek,
				startHour,
				blockHours,
				createdAt: gameNow()
			});
		}
	}

	await db.companies.update(companyId, { lastAiDay: dayIndex });
};

/** True once the world exists (gates + AI airlines + game state). */
export const isSeeded = async (): Promise<boolean> => {
	const state = await db.game_state.get(1);
	return Boolean(state);
};

/** The desks that take the other side of the market. Names only — no balance sheet. */
const BROKERS: { key: string; name: string }[] = [
	{ key: 'ashgrove', name: 'Ashgrove Capital' },
	{ key: 'kestrel', name: 'Kestrel Holdings' },
	{ key: 'northgate', name: 'Northgate Partners' },
	{ key: 'vantage', name: 'Vantage Aviation Fund' }
];

/**
 * Idempotent, and called on every boot rather than once at seeding: desks arrived after the
 * first worlds were saved, so an existing world picks them up the next time it opens.
 * `lastBrokerDay` starts at today, so a desk that appears mid-game never trades backwards
 * across days the clock has already closed.
 */
export const ensureBrokers = async (): Promise<void> => {
	const existing = new Set((await db.brokers.toArray()).map((broker) => broker.key));
	const missing = BROKERS.filter((blueprint) => !existing.has(blueprint.key));
	if (missing.length === 0) return;

	const now = gameNow();
	await db.brokers.bulkAdd(
		missing.map((blueprint) => ({
			...blueprint,
			lastBrokerDay: dayIndexOf(now),
			createdAt: now
		}))
	);
};

/**
 * Builds the world: the AI carriers and the clock. Stands need no seeding at all —
 * they are derived from the airport dataset, so adding airports makes them available
 * immediately, in existing worlds too.
 */
export const seedWorld = async (): Promise<void> => {
	// Ahead of the guard below, so worlds that were seeded before desks existed get them too.
	await ensureBrokers();

	if (await isSeeded()) return;

	const now = gameNow();
	const dayIndex = dayIndexOf(now);

	for (const [index, blueprint] of AI_AIRLINES.entries()) {
		await seedAiAirline(blueprint, index, dayIndex);
	}

	await db.game_state.add({
		id: 1,
		createdAt: now,
		lastTickAt: now,
		lastProcessedDay: dayIndex,
		fuelPricePerLitre: BASE_FUEL_PRICE_PER_LITRE,
		seed: WORLD_SEED,
		seededAt: now,
		clockOffsetMs: 0
	});
};

/** Wipes everything. Used by the settings screen's "restart world" action. */
export const resetWorld = async (): Promise<void> => {
	await db.delete();
	await db.open();
};
