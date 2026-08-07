import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_CASH, advanceHours, freshWorld } from './testing/world';
import { AIRCRAFT_MODELS, defaultSeatConfig } from '$data/aircraft';
import {
	acquireAircraft,
	addScheduleEntry,
	availableGatesAt,
	buyGate,
	companyGates,
	createCompany,
	createRoute,
	deleteRoute
} from '$db/repo';
import { db, type Company } from '$db/schema';
import { diagnoseAircraft } from './diagnostics';

const MONDAY = 0;

const airlineWithAircraft = async (): Promise<{ company: Company; aircraftId: number }> => {
	const company = await createCompany({
		name: 'Idle Air',
		icao: 'IDL',
		homeIata: 'BCN',
		cash: FIXTURE_CASH
	});
	const [homeGate] = await companyGates(company.id);

	const model = AIRCRAFT_MODELS.find(
		(candidate) => candidate.category <= homeGate.maxCategory && candidate.range >= 2000
	);
	if (!model) throw new Error('no model');

	const aircraft = await acquireAircraft({
		companyId: company.id,
		modelId: model.id,
		name: 'Idle One',
		seats: defaultSeatConfig(model),
		ownership: 'owned',
		homeGateId: homeGate.key
	});

	return { company, aircraftId: aircraft.id };
};

describe('aircraft diagnostics', () => {
	beforeEach(async () => {
		await freshWorld();
	});

	describe('WHEN nothing is scheduled', () => {
		it('should say so', async () => {
			const { aircraftId } = await airlineWithAircraft();

			const result = await diagnoseAircraft(aircraftId);

			expect(result.legs).toEqual([]);
			expect(result.summary).toBe('Nothing is scheduled for this aircraft.');
			expect(result.nextDepartureAt).toBeNull();
		});
	});

	describe('WHEN the week is full and every leg can be flown', () => {
		it('should report every leg as flyable and no problem at all', async () => {
			const { company, aircraftId } = await airlineWithAircraft();
			const [homeGate] = await companyGates(company.id);
			const [madridGate] = await availableGatesAt('MAD');
			const route = await createRoute(company.id, homeGate.key, madridGate.key, {
				economy: 120,
				business: 320,
				first: 620
			});

			for (let hour = 0; hour + 2 <= 24; hour += 2) {
				await addScheduleEntry(company.id, aircraftId, route.id, MONDAY, hour);
			}

			const result = await diagnoseAircraft(aircraftId);

			expect(result.blockedCount).toBe(0);
			expect(result.flyableCount).toBe(12);
			expect(result.summary).toBeNull();
			expect(result.nextDepartureAt).not.toBeNull();
		});

		it('should alternate the direction of each leg', async () => {
			const { company, aircraftId } = await airlineWithAircraft();
			const [homeGate] = await companyGates(company.id);
			const [madridGate] = await availableGatesAt('MAD');
			const route = await createRoute(company.id, homeGate.key, madridGate.key, {
				economy: 120,
				business: 320,
				first: 620
			});

			await addScheduleEntry(company.id, aircraftId, route.id, MONDAY, 6);
			await addScheduleEntry(company.id, aircraftId, route.id, MONDAY, 9);

			const result = await diagnoseAircraft(aircraftId);

			expect(result.legs[0].label).toBe('BCN→MAD');
			expect(result.legs[1].label).toBe('MAD→BCN');
		});
	});

	describe('WHEN the week is full but the aircraft is somewhere else', () => {
		it('should explain that no route touches where the aircraft stands', async () => {
			const { company, aircraftId } = await airlineWithAircraft();

			// A route between two other gates, nowhere near the aircraft's home base.
			const [madridGate] = await availableGatesAt('MAD');
			const [londonGate] = await availableGatesAt('LHR');
			await buyGate(company.id, madridGate.key);
			const route = await createRoute(company.id, madridGate.key, londonGate.key, {
				economy: 150,
				business: 400,
				first: 800
			});

			for (let hour = 0; hour + 3 <= 24; hour += 3) {
				await addScheduleEntry(company.id, aircraftId, route.id, MONDAY, hour);
			}

			const result = await diagnoseAircraft(aircraftId);

			expect(result.flyableCount).toBe(0);
			expect(result.blockedCount).toBe(8);
			expect(result.legs.every((leg) => leg.verdict === 'wrong-airport')).toBe(true);
			expect(result.summary).toContain('at BCN');
			expect(result.nextDepartureAt).toBeNull();
		});

		it('should match what the simulation actually does', async () => {
			const { company, aircraftId } = await airlineWithAircraft();
			const [madridGate] = await availableGatesAt('MAD');
			const [londonGate] = await availableGatesAt('LHR');
			await buyGate(company.id, madridGate.key);
			const route = await createRoute(company.id, madridGate.key, londonGate.key, {
				economy: 150,
				business: 400,
				first: 800
			});
			await addScheduleEntry(company.id, aircraftId, route.id, MONDAY, 6);

			await advanceHours(24 * 8);

			const flights = await db.flights.where('aircraftId').equals(aircraftId).count();
			const aircraft = await db.aircraft.get(aircraftId);

			expect(flights).toBe(0);
			expect(aircraft!.status).toBe('idle');
		});
	});

	describe('WHEN a route is out of range', () => {
		it('should name the range that is short', async () => {
			const company = await createCompany({ name: 'Short Air', icao: 'SHT', homeIata: 'BCN' });
			const [homeGate] = await companyGates(company.id);
			const shortRange = AIRCRAFT_MODELS.find(
				(candidate) => candidate.category <= homeGate.maxCategory && candidate.range < 2000
			);
			if (!shortRange) throw new Error('no model');

			const aircraft = await acquireAircraft({
				companyId: company.id,
				modelId: shortRange.id,
				name: 'Short One',
				seats: defaultSeatConfig(shortRange),
				ownership: 'owned',
				homeGateId: homeGate.key
			});

			const [sydneyGate] = await availableGatesAt('SYD');
			const route = await createRoute(company.id, homeGate.key, sydneyGate.key, {
				economy: 900,
				business: 2400,
				first: 4600
			});

			// The scheduler refuses such a leg, so this can only arrive by the route
			// outliving the aircraft that could fly it — the diagnosis still has to explain it.
			await db.schedule_entries.add({
				companyId: company.id,
				aircraftId: aircraft.id,
				routeId: route.id,
				dayOfWeek: MONDAY,
				startHour: 6,
				blockHours: 4,
				createdAt: Date.now()
			});

			const result = await diagnoseAircraft(aircraft.id);

			expect(result.legs[0].verdict).toBe('out-of-range');
			expect(result.legs[0].detail).toContain('range');
			expect(result.summary).toContain('range');
		});
	});

	describe('WHEN a scheduled route has been closed', () => {
		it('should flag the orphaned leg', async () => {
			const { company, aircraftId } = await airlineWithAircraft();
			const [homeGate] = await companyGates(company.id);
			const [madridGate] = await availableGatesAt('MAD');
			const route = await createRoute(company.id, homeGate.key, madridGate.key, {
				economy: 120,
				business: 320,
				first: 620
			});
			await addScheduleEntry(company.id, aircraftId, route.id, MONDAY, 6);

			// Closing a route drops its legs, so re-add one pointing at the dead route.
			await deleteRoute(route.id);
			await db.schedule_entries.add({
				companyId: company.id,
				aircraftId,
				routeId: route.id,
				dayOfWeek: MONDAY,
				startHour: 6,
				blockHours: 2,
				createdAt: Date.now()
			});

			const result = await diagnoseAircraft(aircraftId);

			expect(result.legs[0].verdict).toBe('route-missing');
		});
	});

	describe('WHEN the aircraft itself is unavailable', () => {
		it.each`
			status            | expected
			${'delivering'}   | ${'delivery'}
			${'maintenance'}  | ${'hangar'}
			${'grounded'}     | ${'Grounded'}
		`('should explain a $status aircraft', async ({ status, expected }) => {
			const { company, aircraftId } = await airlineWithAircraft();
			const [homeGate] = await companyGates(company.id);
			const [madridGate] = await availableGatesAt('MAD');
			const route = await createRoute(company.id, homeGate.key, madridGate.key, {
				economy: 120,
				business: 320,
				first: 620
			});
			await addScheduleEntry(company.id, aircraftId, route.id, MONDAY, 6);
			await db.aircraft.update(aircraftId, { status });

			const result = await diagnoseAircraft(aircraftId);

			expect(result.summary).toContain(expected);
		});
	});
});
