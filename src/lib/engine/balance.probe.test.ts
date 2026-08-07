import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_CASH, advanceHours, freshWorld } from './testing/world';
import {
	AIRCRAFT_MODELS,
	CARGO_MODELS,
	blockHoursSlots,
	defaultSeatConfig,
	totalSeats
} from '$data/aircraft';
import {
	acquireAircraft,
	addScheduleEntry,
	availableGatesAt,
	companyGates,
	createCompany,
	createRoute
} from '$db/repo';
import { db } from '$db/schema';
import { routeDemand } from './demand';

const DAYS = 14;
const MID_SIZE_FREIGHTER_CEILING = 150_000_000;

describe('world balance probe', () => {
	beforeEach(async () => {
		await freshWorld();
	});

	it('should keep AI airlines active and solvent over two weeks', async () => {
		const before = await Promise.all(
			(await db.companies.where('controller').equals('ai').toArray()).map(async (company) => ({
				id: company.id,
				icao: company.icao,
				cash: company.cash,
				fleet: await db.aircraft.where('companyId').equals(company.id).count(),
				routes: await db.routes.where('companyId').equals(company.id).count()
			}))
		);

		await advanceHours(24 * DAYS);

		const after = await Promise.all(
			before.map(async (snapshot) => {
				const company = await db.companies.get(snapshot.id);
				return {
					icao: snapshot.icao,
					cashBefore: Math.round(snapshot.cash / 1_000_000),
					cashAfter: Math.round(company!.cash / 1_000_000),
					fleetBefore: snapshot.fleet,
					fleetAfter: await db.aircraft.where('companyId').equals(snapshot.id).count(),
					routesBefore: snapshot.routes,
					routesAfter: await db.routes.where('companyId').equals(snapshot.id).count()
				};
			})
		);

		const flights = await db.flights.count();
		const listings = await db.share_listings.count();
		const grew = after.filter(
			(row) => row.fleetAfter > row.fleetBefore || row.routesAfter > row.routesBefore
		);

		console.table(after);
		console.log({ flights, listings, grew: grew.length });

		// The world must be alive: flights operated and at least some carriers investing.
		expect(flights).toBeGreaterThan(50);
		expect(grew.length).toBeGreaterThan(0);
	});

	it('should let a well-run freight route turn a profit', async () => {
		const company = await createCompany({
			name: 'Probe Cargo',
			icao: 'PCG',
			homeIata: 'FRA',
			cash: FIXTURE_CASH
		});
		const [homeGate] = await companyGates(company.id);

		// The biggest mid-size freighter the hub can take. The price ceiling keeps the
		// aircraft small enough for a single route to fill its hold — the probe asks
		// whether flying it pays, not whether an opening balance can buy it.
		const model = CARGO_MODELS.filter(
			(candidate) =>
				candidate.category <= homeGate.maxCategory &&
				candidate.range >= 5000 &&
				candidate.price < MID_SIZE_FREIGHTER_CEILING
		).sort((left, right) => right.payload - left.payload)[0];
		if (!model) throw new Error('no freighter');

		const aircraft = await acquireAircraft({
			companyId: company.id,
			modelId: model.id,
			name: 'Probe Freighter',
			seats: { economy: 0, business: 0, first: 0 },
			ownership: 'owned',
			homeGateId: homeGate.key
		});

		const [newYork] = await availableGatesAt('JFK');
		const route = await createRoute(company.id, homeGate.key, newYork.key, {
			economy: 400,
			business: 1000,
			first: 2000
		});

		const legHours = blockHoursSlots(model, route.distanceKm);
		for (let day = 0; day < 7; day += 1) {
			for (let hour = 0; hour + legHours <= 24; hour += legHours) {
				await addScheduleEntry(company.id, aircraft.id, route.id, day, hour);
			}
		}

		await advanceHours(24 * DAYS);

		const records = await db.transaction_records.where('companyId').equals(company.id).toArray();
		const byCategory = new Map<string, number>();
		for (const record of records) {
			byCategory.set(record.category, (byCategory.get(record.category) ?? 0) + record.amount);
		}

		const flights = await db.flights.where('aircraftId').equals(aircraft.id).toArray();
		const averageTonnes =
			flights.reduce((sum, flight) => sum + flight.cargoTonnes, 0) / Math.max(1, flights.length);
		const operatingResult = ['freight_sales', 'fuel', 'airport_tax', 'wages', 'maintenance'].reduce(
			(sum, category) => sum + (byCategory.get(category) ?? 0),
			0
		);

		console.log({
			model: model.name,
			payloadTonnes: model.payload,
			ratePerTonne: route.cargoRatePerTonne,
			flights: flights.length,
			averageTonnes: Math.round(averageTonnes * 10) / 10,
			operatingResultThousands: Math.round(operatingResult / 1000),
			ledger: Object.fromEntries(
				[...byCategory.entries()].map(([category, amount]) => [
					category,
					Math.round(amount / 1000)
				])
			)
		});

		expect(flights.length).toBeGreaterThan(10);
		expect(averageTonnes).toBeGreaterThan(model.payload * 0.5);
		// Freight has to pay its way, or the whole cargo fleet is decoration.
		expect(operatingResult).toBeGreaterThan(0);
	});

	it('should let a well-run player route turn a profit', async () => {
		const company = await createCompany({
			name: 'Probe Air',
			icao: 'PRB',
			homeIata: 'BCN',
			cash: FIXTURE_CASH
		});
		const [homeGate] = await companyGates(company.id);

		const model = AIRCRAFT_MODELS.find(
			(candidate) =>
				candidate.category <= homeGate.maxCategory &&
				candidate.range >= 1500 &&
				candidate.seats >= 150
		);
		if (!model) throw new Error('no model');

		const aircraft = await acquireAircraft({
			companyId: company.id,
			modelId: model.id,
			name: 'Probe One',
			seats: defaultSeatConfig(model),
			ownership: 'owned',
			homeGateId: homeGate.key
		});

		const [outGate] = await availableGatesAt('MAD');
		const route = await createRoute(company.id, homeGate.key, outGate.key, {
			economy: 0,
			business: 0,
			first: 0
		});
		const demand = routeDemand('BCN', 'MAD', route.distanceKm);
		await db.routes.update(route.id, { prices: demand.idealPrice });

		// A route is bidirectional, so consecutive legs alternate out and back on their
		// own. Two round trips a day is a sane rotation: enough to fill the aircraft
		// without flooding the market with more seats than there is demand.
		const legHours = blockHoursSlots(model, route.distanceKm);
		const legsPerDay = 4;
		for (let day = 0; day < 7; day += 1) {
			for (let leg = 0; leg < legsPerDay; leg += 1) {
				const hour = 6 + leg * legHours;
				if (hour + legHours > 24) break;
				await addScheduleEntry(company.id, aircraft.id, route.id, day, hour);
			}
		}

		const cashAfterSetup = (await db.companies.get(company.id))!.cash;
		await advanceHours(24 * DAYS);

		const records = await db.transaction_records.where('companyId').equals(company.id).toArray();
		const byCategory = new Map<string, number>();
		for (const record of records) {
			byCategory.set(record.category, (byCategory.get(record.category) ?? 0) + record.amount);
		}

		const flights = await db.flights.where('companyId').equals(company.id).toArray();
		const operated = flights.filter((flight) => flight.status !== 'flying');
		const averageLoad =
			operated.reduce(
				(sum, flight) => sum + flight.pax.economy + flight.pax.business + flight.pax.first,
				0
			) / Math.max(1, operated.length);

		const finalCash = (await db.companies.get(company.id))!.cash;

		console.log({
			model: model.name,
			seats: totalSeats(aircraft.seats),
			legHours,
			weeklyLegs: await db.schedule_entries.where('companyId').equals(company.id).count(),
			flights: operated.length,
			averageLoad: Math.round(averageLoad),
			cashAfterSetup: Math.round(cashAfterSetup / 1_000_000),
			finalCash: Math.round(finalCash / 1_000_000),
			ledger: Object.fromEntries(
				[...byCategory.entries()].map(([category, amount]) => [
					category,
					Math.round(amount / 1_000)
				])
			)
		});

		const operatingResult =
			(byCategory.get('ticket_sales') ?? 0) +
			(byCategory.get('fuel') ?? 0) +
			(byCategory.get('airport_tax') ?? 0) +
			(byCategory.get('wages') ?? 0) +
			(byCategory.get('maintenance') ?? 0);

		expect(operated.length).toBeGreaterThan(20);
		expect(averageLoad).toBeGreaterThan(60);
		// A sensibly run route has to make money, or the game is unwinnable.
		expect(operatingResult).toBeGreaterThan(0);
	});
});
