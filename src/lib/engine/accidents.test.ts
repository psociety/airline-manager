import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_CASH, advanceHours, freshWorld } from './testing/world';
import { AIRCRAFT_MODELS, defaultSeatConfig, getModel } from '$data/aircraft';
import {
	acquireAircraft,
	addScheduleEntry,
	availableGatesAt,
	clearSchedule,
	companyGates,
	createCompany,
	createRoute,
	fightIncident,
	sendToMaintenance
} from '$db/repo';
import { db, type Company } from '$db/schema';

const flyingAirline = async (
	icao = 'RSK'
): Promise<{ company: Company; aircraftId: number }> => {
	const company = await createCompany({
		name: `Risk Air ${icao}`,
		icao,
		homeIata: 'BCN',
		cash: FIXTURE_CASH
	});
	const [homeGate] = await companyGates(company.id);

	const model = AIRCRAFT_MODELS.find(
		(candidate) =>
			candidate.category <= homeGate.maxCategory &&
			candidate.range >= 1000 &&
			candidate.seats >= 150
	);
	if (!model) throw new Error('no model');

	const aircraft = await acquireAircraft({
		companyId: company.id,
		modelId: model.id,
		name: 'Risk One',
		seats: defaultSeatConfig(model),
		ownership: 'owned',
		homeGateId: homeGate.key
	});

	const [targetGate] = await availableGatesAt('MAD');
	const route = await createRoute(company.id, homeGate.key, targetGate.key, {
		economy: 120,
		business: 320,
		first: 620
	});

	for (let day = 0; day < 7; day += 1) {
		for (let leg = 0; leg < 6; leg += 1) {
			await addScheduleEntry(company.id, aircraft.id, route.id, day, 2 + leg * 3);
		}
	}

	return { company, aircraftId: aircraft.id };
};

describe('accidents and maintenance', () => {
	/**
	 * Three airlines flying the same punishing schedule in one world, each starting its
	 * airframe at a different point in its service life, then a single week flown. Every
	 * assertion below is scoped to its own carrier and only reads what happened.
	 */
	describe('WHEN a player keeps flying an overdue airframe', () => {
		let nearlyDue = 0;
		let longOverdue = 0;
		let freshlyChecked = 0;

		beforeAll(async () => {
			await freshWorld();
			const near = await flyingAirline('NRD');
			const over = await flyingAirline('OVR');
			const fresh = await flyingAirline('FRS');
			nearlyDue = near.aircraftId;
			longOverdue = over.aircraftId;
			freshlyChecked = fresh.aircraftId;

			const model = getModel((await db.aircraft.get(nearlyDue))!.modelId);
			await db.aircraft.update(nearlyDue, {
				kmSinceMaintenance: model.maintenanceIntervalKm - 100
			});
			// Far past the interval, so the per-flight risk sits at its ceiling.
			await db.aircraft.update(longOverdue, {
				kmSinceMaintenance: model.maintenanceIntervalKm * 12
			});
			await db.aircraft.update(freshlyChecked, { kmSinceMaintenance: 0 });

			await advanceHours(24 * 7);
		});

		it('should never service it behind the player’s back', async () => {
			const aircraft = await db.aircraft.get(nearlyDue);
			const checks = await db.transaction_records
				.where('companyId')
				.equals(aircraft!.companyId)
				.filter((record) => record.category === 'maintenance')
				.count();

			// Either still flying overdue, or grounded by an accident — never auto-serviced.
			expect(checks).toBe(0);
			expect(['idle', 'flying', 'grounded']).toContain(aircraft!.status);
		});

		it('should eventually suffer an accident and open a claim', async () => {
			const aircraft = await db.aircraft.get(longOverdue);
			const incidents = await db.incidents.where('companyId').equals(aircraft!.companyId).toArray();

			expect(incidents.length).toBeGreaterThan(0);
			expect(incidents[0].baseAmount).toBeGreaterThan(0);
			expect(aircraft!.status).toBe('grounded');
		});

		it('should not crash an airframe that is kept inside its interval', async () => {
			const aircraft = await db.aircraft.get(freshlyChecked);
			const incidents = await db.incidents.where('companyId').equals(aircraft!.companyId).count();

			expect(incidents).toBe(0);
		});
	});

	describe('WHEN the player sends an aircraft for a check', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should ground it, bill the work and reset the odometer when done', async () => {
			const { company, aircraftId } = await flyingAirline();
			const model = getModel((await db.aircraft.get(aircraftId))!.modelId);
			await db.aircraft.update(aircraftId, {
				kmSinceMaintenance: model.maintenanceIntervalKm * 2,
				status: 'idle'
			});

			await sendToMaintenance(aircraftId);

			const grounded = await db.aircraft.get(aircraftId);
			expect(grounded!.status).toBe('maintenance');

			const bill = await db.transaction_records
				.where('companyId')
				.equals(company.id)
				.filter((record) => record.category === 'maintenance')
				.toArray();
			expect(bill).toHaveLength(1);

			// Clear the week first: otherwise the aircraft resumes flying inside the same
			// catch-up and what we observe depends on the hour the test happens to run at.
			await clearSchedule(aircraftId);
			await advanceHours(model.maintenanceHours + 1);

			const serviced = await db.aircraft.get(aircraftId);
			expect(serviced!.status).toBe('idle');
			expect(serviced!.kmSinceMaintenance).toBe(0);
		});

		it('should refuse while the aircraft is in the air', async () => {
			const { aircraftId } = await flyingAirline();
			await db.aircraft.update(aircraftId, { status: 'flying' });

			await expect(sendToMaintenance(aircraftId)).rejects.toThrow('landed');
		});
	});

	describe('WHEN a claim is fought in court', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should either cost nothing or more than the original claim', async () => {
			const company = await createCompany({ name: 'Court Air', icao: 'CRT', homeIata: 'MAD' });
			const [gate] = await companyGates(company.id);
			const model = AIRCRAFT_MODELS.find(
				(candidate) => candidate.category <= gate.maxCategory && candidate.price < 20_000_000
			);
			if (!model) throw new Error('no model');

			const aircraft = await acquireAircraft({
				companyId: company.id,
				modelId: model.id,
				name: 'Court One',
				seats: defaultSeatConfig(model),
				ownership: 'owned',
				homeGateId: gate.key
			});

			const baseAmount = 3_000_000;
			const incidentId = await db.incidents.add({
				companyId: company.id,
				aircraftId: aircraft.id,
				aircraftName: aircraft.name,
				flightId: null,
				at: Date.now(),
				passengers: 60,
				baseAmount,
				status: 'pending',
				outcome: null,
				finalAmount: null,
				resolvedAt: null
			});

			const cashBefore = (await db.companies.get(company.id))!.cash;
			const outcome = await fightIncident(incidentId);
			const cashAfter = (await db.companies.get(company.id))!.cash;

			if (outcome.won) {
				expect(outcome.amount).toBe(0);
				expect(cashAfter).toBe(cashBefore);
			} else {
				expect(outcome.amount).toBeGreaterThan(baseAmount);
				expect(outcome.amount).toBeLessThanOrEqual(baseAmount * 2);
				expect(cashAfter).toBe(cashBefore - outcome.amount);
			}

			const resolved = await db.incidents.get(incidentId);
			expect(resolved!.status).not.toBe('pending');
		});
	});
});
