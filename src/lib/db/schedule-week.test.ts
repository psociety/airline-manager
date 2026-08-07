import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceHours, freshWorld } from '$engine/testing/world';
import { AIRCRAFT_MODELS, defaultSeatConfig } from '$data/aircraft';
import {
	acquireAircraft,
	addScheduleEntry,
	availableGatesAt,
	clearSchedule,
	companyGates,
	copyScheduleDay,
	createCompany,
	createRoute,
	scheduleForAircraft
} from './repo';
import { STARTING_CASH, db } from './schema';

const MONDAY = 0;
const TUESDAY = 1;

const setUp = async () => {
	const company = await createCompany({ name: 'Week Air', icao: 'WKA', homeIata: 'BCN' });
	const [homeGate] = await companyGates(company.id);

	const model = AIRCRAFT_MODELS.find(
		(candidate) =>
			candidate.category <= homeGate.maxCategory &&
			candidate.range >= 1000 &&
			candidate.price < STARTING_CASH / 3
	);
	if (!model) throw new Error('no model');

	const aircraft = await acquireAircraft({
		companyId: company.id,
		modelId: model.id,
		name: 'Week One',
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

	return { company, aircraft, route };
};

describe('weekly schedule helpers', () => {
	describe('WHEN Monday is copied across the week', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should repeat every Monday leg on all six other days', async () => {
			const { company, aircraft, route } = await setUp();
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 6);
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 10);

			const added = await copyScheduleDay(aircraft.id, MONDAY);
			const week = await scheduleForAircraft(aircraft.id);

			expect(added).toBe(12);
			expect(week).toHaveLength(14);

			for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
				const day = week.filter((entry) => entry.dayOfWeek === dayOfWeek);
				expect(day.map((entry) => entry.startHour).sort((a, b) => a - b)).toEqual([6, 10]);
			}
		});

		it('should carry the route and block length of each leg', async () => {
			const { company, aircraft, route } = await setUp();
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 8);
			const [monday] = await scheduleForAircraft(aircraft.id);

			await copyScheduleDay(aircraft.id, MONDAY);
			const week = await scheduleForAircraft(aircraft.id);

			for (const entry of week) {
				expect(entry.routeId).toBe(monday.routeId);
				expect(entry.blockHours).toBe(monday.blockHours);
				expect(entry.companyId).toBe(company.id);
				expect(entry.aircraftId).toBe(aircraft.id);
			}
		});

		it('should replace whatever the other days already held', async () => {
			const { company, aircraft, route } = await setUp();
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 6);
			await addScheduleEntry(company.id, aircraft.id, route.id, TUESDAY, 15);
			await addScheduleEntry(company.id, aircraft.id, route.id, TUESDAY, 19);

			await copyScheduleDay(aircraft.id, MONDAY);
			const tuesday = (await scheduleForAircraft(aircraft.id)).filter(
				(entry) => entry.dayOfWeek === TUESDAY
			);

			expect(tuesday).toHaveLength(1);
			expect(tuesday[0].startHour).toBe(6);
		});

		it('should leave Monday itself untouched', async () => {
			const { company, aircraft, route } = await setUp();
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 7);
			const before = (await scheduleForAircraft(aircraft.id)).filter(
				(entry) => entry.dayOfWeek === MONDAY
			);

			await copyScheduleDay(aircraft.id, MONDAY);
			const after = (await scheduleForAircraft(aircraft.id)).filter(
				(entry) => entry.dayOfWeek === MONDAY
			);

			expect(after.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
		});

		it('should refuse when Monday is empty', async () => {
			const { company, aircraft, route } = await setUp();
			await addScheduleEntry(company.id, aircraft.id, route.id, TUESDAY, 9);

			await expect(copyScheduleDay(aircraft.id, MONDAY)).rejects.toThrow(
				'Nothing is scheduled on Monday'
			);

			const week = await scheduleForAircraft(aircraft.id);
			expect(week).toHaveLength(1);
		});

		it('should not touch another aircraft’s week', async () => {
			const { company, aircraft, route } = await setUp();
			const [homeGate] = await companyGates(company.id);
			const model = AIRCRAFT_MODELS.find(
				(candidate) => candidate.category <= homeGate.maxCategory && candidate.price < 20_000_000
			);
			if (!model) throw new Error('no model');

			const other = await acquireAircraft({
				companyId: company.id,
				modelId: model.id,
				name: 'Week Two',
				seats: defaultSeatConfig(model),
				ownership: 'owned',
				homeGateId: homeGate.key
			});
			await db.aircraft.update(other.id, { status: 'idle' });
			await addScheduleEntry(company.id, other.id, route.id, TUESDAY, 12);
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 6);

			await copyScheduleDay(aircraft.id, MONDAY);

			const otherWeek = await scheduleForAircraft(other.id);
			expect(otherWeek).toHaveLength(1);
			expect(otherWeek[0].startHour).toBe(12);
		});

	});

	describe('WHEN a schedule is reset', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should clear every leg and report how many went', async () => {
			const { company, aircraft, route } = await setUp();
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 6);
			await copyScheduleDay(aircraft.id, MONDAY);

			const cleared = await clearSchedule(aircraft.id);

			expect(cleared).toBe(7);
			expect(await scheduleForAircraft(aircraft.id)).toEqual([]);
		});

		it('should leave the routes and the aircraft in place', async () => {
			const { company, aircraft, route } = await setUp();
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 6);

			await clearSchedule(aircraft.id);

			expect(await db.routes.get(route.id)).toBeDefined();
			expect(await db.aircraft.get(aircraft.id)).toBeDefined();
		});

		it('should not touch another aircraft’s week', async () => {
			const { company, aircraft, route } = await setUp();
			const [homeGate] = await companyGates(company.id);
			const model = AIRCRAFT_MODELS.find(
				(candidate) => candidate.category <= homeGate.maxCategory && candidate.price < 20_000_000
			);
			if (!model) throw new Error('no model');

			const other = await acquireAircraft({
				companyId: company.id,
				modelId: model.id,
				name: 'Week Two',
				seats: defaultSeatConfig(model),
				ownership: 'owned',
				homeGateId: homeGate.key
			});
			await addScheduleEntry(company.id, other.id, route.id, MONDAY, 9);
			await addScheduleEntry(company.id, aircraft.id, route.id, MONDAY, 6);

			await clearSchedule(aircraft.id);

			expect(await scheduleForAircraft(other.id)).toHaveLength(1);
		});

		it('should be safe to call on an empty week', async () => {
			const { aircraft } = await setUp();

			const cleared = await clearSchedule(aircraft.id);

			expect(cleared).toBe(0);
		});

	});

	/**
	 * One week flown once, with two aircraft: one keeps its copied week, the other has it
	 * cleared. Both assertions only count the flights afterwards.
	 */
	describe('WHEN a copied week is flown', () => {
		let flyingId = 0;
		let clearedId = 0;

		beforeAll(async () => {
			await freshWorld();
			const { company, aircraft, route } = await setUp();
			flyingId = aircraft.id;

			const second = await acquireAircraft({
				companyId: company.id,
				modelId: aircraft.modelId,
				name: 'Week Two',
				seats: aircraft.seats,
				ownership: 'owned',
				homeGateId: aircraft.homeGateId
			});
			clearedId = second.id;

			await addScheduleEntry(company.id, flyingId, route.id, MONDAY, 6);
			await copyScheduleDay(flyingId, MONDAY);

			await addScheduleEntry(company.id, clearedId, route.id, MONDAY, 8);
			await copyScheduleDay(clearedId, MONDAY);
			await clearSchedule(clearedId);

			await advanceHours(24 * 8);
		});

		it('should produce a week the simulation actually flies', async () => {
			expect(await db.flights.where('aircraftId').equals(flyingId).count()).toBeGreaterThanOrEqual(
				7
			);
		});

		it('should stop the aircraft flying anything afterwards', async () => {
			expect(await db.flights.where('aircraftId').equals(clearedId).count()).toBe(0);
		});
	});
});
