import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_CASH, advanceHours, freshWorld } from './testing/world';
import { CARGO_MODELS, PASSENGER_MODELS, getModel } from '$data/aircraft';
import {
	acquireAircraft,
	addScheduleEntry,
	availableGatesAt,
	companyGates,
	createCompany,
	createRoute,
	updateCargoRate
} from '$db/repo';
import { db, type Company } from '$db/schema';
import { cargoForFlight, idealCargoRate, routeCargoDemand } from './demand';

const MONDAY = 0;

/** An airline with one freighter and one route out of its hub. */
const freightAirline = async (): Promise<{
	company: Company;
	aircraftId: number;
	routeId: number;
	payload: number;
}> => {
	const company = await createCompany({
		name: 'Freight Air',
		icao: 'FRT',
		homeIata: 'BCN',
		cash: FIXTURE_CASH
	});
	const [homeGate] = await companyGates(company.id);

	const model = CARGO_MODELS.find(
		(candidate) => candidate.category <= homeGate.maxCategory && candidate.range >= 1000
	);
	if (!model) throw new Error('no freighter fits the home stand');

	const aircraft = await acquireAircraft({
		companyId: company.id,
		modelId: model.id,
		name: 'Freight One',
		seats: { economy: 0, business: 0, first: 0 },
		ownership: 'owned',
		homeGateId: homeGate.key
	});

	const [madridGate] = await availableGatesAt('MAD');
	const route = await createRoute(company.id, homeGate.key, madridGate.key, {
		economy: 100,
		business: 250,
		first: 500
	});

	return { company, aircraftId: aircraft.id, routeId: route.id, payload: model.payload };
};

describe('freight operations', () => {
	// No world: these three blocks exercise pure demand and hold-filling maths.
	describe('WHEN freight demand is generated for a pair', () => {
		it('should be the same every time it is asked', () => {
			const first = routeCargoDemand('BCN', 'MAD', 483);
			const second = routeCargoDemand('BCN', 'MAD', 483);

			expect(second).toEqual(first);
		});

		it('should not depend on the direction of travel', () => {
			const outbound = routeCargoDemand('BCN', 'MAD', 483);
			const inbound = routeCargoDemand('MAD', 'BCN', 483);

			expect(inbound.tonnesPerDay).toBe(outbound.tonnesPerDay);
		});

		it('should carry more freight between two big hubs than two small fields', () => {
			const major = routeCargoDemand('HKG', 'LAX', 11_600);
			const minor = routeCargoDemand('ASU', 'SAL', 4_600);

			expect(major.tonnesPerDay).toBeGreaterThan(minor.tonnesPerDay);
		});

		it('should always offer at least a tonne, so no pair is dead', () => {
			const thin = routeCargoDemand('ASU', 'SAL', 4_600);

			expect(thin.tonnesPerDay).toBeGreaterThanOrEqual(1);
		});
	});

	describe('WHEN a freight rate is quoted', () => {
		it.each`
			distance  | minimum | maximum
			${1000}   | ${550}  | ${750}
			${5000}   | ${1900} | ${2300}
			${10000}  | ${3400} | ${4000}
		`(
			'should ask between $minimum and $maximum € a tonne over $distance km',
			({ distance, minimum, maximum }) => {
				const result = idealCargoRate(distance);

				expect(result).toBeGreaterThanOrEqual(minimum);
				expect(result).toBeLessThanOrEqual(maximum);
			}
		);

		it('should charge less per tonne-kilometre the further it goes', () => {
			const short = idealCargoRate(1000) / 1000;
			const long = idealCargoRate(10_000) / 10_000;

			expect(long).toBeLessThan(short);
		});
	});

	describe('WHEN a hold is filled', () => {
		const demand = routeCargoDemand('HKG', 'LAX', 11_600);

		it('should never load more than the hold takes', () => {
			const result = cargoForFlight({
				demand,
				ratePerTonne: 1,
				capacityTonnes: 20,
				flightsPerDay: 1,
				competitors: []
			});

			expect(result).toBeLessThanOrEqual(20);
		});

		it('should load nothing into an aircraft with no hold', () => {
			const result = cargoForFlight({
				demand,
				ratePerTonne: demand.idealRatePerTonne,
				capacityTonnes: 0,
				flightsPerDay: 1,
				competitors: []
			});

			expect(result).toBe(0);
		});

		it('should load less as the rate rises', () => {
			const base = { demand, capacityTonnes: 500, flightsPerDay: 1, competitors: [] };

			const cheap = cargoForFlight({ ...base, ratePerTonne: demand.idealRatePerTonne });
			const dear = cargoForFlight({
				...base,
				ratePerTonne: demand.idealRatePerTonne * 1.6
			});

			expect(dear).toBeLessThan(cheap);
		});

		it('should lose freight to a rival on the same pair', () => {
			const base = {
				demand,
				ratePerTonne: demand.idealRatePerTonne,
				capacityTonnes: 500,
				flightsPerDay: 1
			};

			const alone = cargoForFlight({ ...base, competitors: [] });
			const contested = cargoForFlight({
				...base,
				competitors: [{ tonnesPerDay: 1000, ratePerTonne: demand.idealRatePerTonne }]
			});

			expect(contested).toBeLessThan(alone);
		});
	});

	describe('WHEN a freighter is bought', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should be allowed with an empty cabin', async () => {
			const { aircraftId } = await freightAirline();
			const aircraft = await db.aircraft.get(aircraftId);

			expect(aircraft).toBeDefined();
			expect(aircraft!.seats).toEqual({ economy: 0, business: 0, first: 0 });
			expect(getModel(aircraft!.modelId).kind).toBe('cargo');
		});

		it('should be refused a cabin full of seats', async () => {
			const company = await createCompany({
				name: 'Combi Air',
				icao: 'CMB',
				homeIata: 'BCN',
				cash: FIXTURE_CASH
			});
			const [homeGate] = await companyGates(company.id);
			const model = CARGO_MODELS.find(
				(candidate) => candidate.category <= homeGate.maxCategory
			);
			if (!model) throw new Error('no freighter');

			await expect(
				acquireAircraft({
					companyId: company.id,
					modelId: model.id,
					name: 'Combi One',
					seats: { economy: 100, business: 0, first: 0 },
					ownership: 'owned',
					homeGateId: homeGate.key
				})
			).rejects.toThrow();
		});

		it('should still be refused an empty cabin when it carries passengers', async () => {
			const company = await createCompany({
				name: 'Empty Air',
				icao: 'EMP',
				homeIata: 'BCN',
				cash: FIXTURE_CASH
			});
			const [homeGate] = await companyGates(company.id);
			const model = PASSENGER_MODELS.find(
				(candidate) => candidate.category <= homeGate.maxCategory
			);
			if (!model) throw new Error('no passenger model');

			await expect(
				acquireAircraft({
					companyId: company.id,
					modelId: model.id,
					name: 'Empty One',
					seats: { economy: 0, business: 0, first: 0 },
					ownership: 'owned',
					homeGateId: homeGate.key
				})
			).rejects.toThrow('at least one seat');
		});
	});

	/**
	 * One freighter week, flown once and then only read. A test that changes the route or the
	 * rate before flying needs its own world — see the sibling block below.
	 */
	describe('WHEN a freighter has flown its schedule', () => {
		let flownCompanyId = 0;
		let flownAircraftId = 0;
		let holdPayload = 0;

		beforeAll(async () => {
			await freshWorld();
			const { company, aircraftId, routeId, payload } = await freightAirline();
			flownCompanyId = company.id;
			flownAircraftId = aircraftId;
			holdPayload = payload;

			for (let day = 0; day < 7; day += 1) {
				await addScheduleEntry(company.id, aircraftId, routeId, day, 6);
			}

			await advanceHours(24 * 8);
		});

		const flownFlights = async () => db.flights.where('aircraftId').equals(flownAircraftId).toArray();

		it('should carry tonnes and bank freight revenue', async () => {
			const flights = await flownFlights();
			expect(flights.length).toBeGreaterThan(0);

			const flown = flights[0];
			expect(flown.cargoTonnes).toBeGreaterThan(0);
			expect(flown.pax).toEqual({ economy: 0, business: 0, first: 0 });
			expect(flown.revenue).toBeGreaterThan(0);

			const freight = await db.transaction_records
				.where('companyId')
				.equals(flownCompanyId)
				.filter((record) => record.category === 'freight_sales')
				.toArray();

			expect(freight.length).toBeGreaterThan(0);
			expect(freight[0].description).toContain('t freight');
		});

		it('should still burn fuel and pay the departure charges', async () => {
			const records = await db.transaction_records
				.where('companyId')
				.equals(flownCompanyId)
				.toArray();
			const fuel = records.filter((record) => record.category === 'fuel');
			const charges = records.filter((record) => record.category === 'airport_tax');

			expect(fuel.length).toBeGreaterThan(0);
			expect(fuel.every((record) => record.amount < 0)).toBe(true);
			expect(charges.length).toBeGreaterThan(0);
		});

		it('should never load more than the hold takes, in flight as in theory', async () => {
			const flights = await flownFlights();
			const overloaded = flights.filter((flight) => flight.cargoTonnes > holdPayload);

			expect(overloaded).toEqual([]);
		});
	});

	describe('WHEN the rate is changed before the freighter flies', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should earn nothing once the rate is set absurdly high', async () => {
			const { company, aircraftId, routeId } = await freightAirline();
			await updateCargoRate(routeId, idealCargoRate(483) * 20);
			await addScheduleEntry(company.id, aircraftId, routeId, MONDAY, 6);

			await advanceHours(24 * 8);

			const flights = await db.flights.where('aircraftId').equals(aircraftId).toArray();

			expect(flights.length).toBeGreaterThan(0);
			expect(flights.every((flight) => flight.cargoTonnes === 0)).toBe(true);
			expect(flights.every((flight) => flight.revenue === 0)).toBe(true);
		});
	});

	describe('WHEN passenger aircraft fly the same route', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should carry no freight, leaving the two pools separate', async () => {
			const company = await createCompany({
				name: 'Mixed Air',
				icao: 'MIX',
				homeIata: 'BCN',
				cash: FIXTURE_CASH
			});
			const [homeGate] = await companyGates(company.id);
			const model = PASSENGER_MODELS.find(
				(candidate) => candidate.category <= homeGate.maxCategory && candidate.seats > 100
			);
			if (!model) throw new Error('no passenger model');

			const { defaultSeatConfig } = await import('$data/aircraft');
			const aircraft = await acquireAircraft({
				companyId: company.id,
				modelId: model.id,
				name: 'Mixed One',
				seats: defaultSeatConfig(model),
				ownership: 'owned',
				homeGateId: homeGate.key
			});

			const [madridGate] = await availableGatesAt('MAD');
			const route = await createRoute(company.id, homeGate.key, madridGate.key, {
				economy: 120,
				business: 320,
				first: 620
			});
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 6);

			await advanceHours(24 * 8);

			const flights = await db.flights.where('aircraftId').equals(aircraft.id).toArray();

			expect(flights.length).toBeGreaterThan(0);
			expect(flights.every((flight) => flight.cargoTonnes === 0)).toBe(true);
			expect(flights.some((flight) => flight.pax.economy > 0)).toBe(true);
		});
	});
});
