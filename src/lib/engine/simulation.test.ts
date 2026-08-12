import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_CASH, advanceHours, freshWorld, runAiDays } from './testing/world';
import { hiringDispositionOf } from './ai';
import { TOTAL_GATE_COUNT, gateCountFor } from '$data/gates';
import { AIRCRAFT_MODELS, defaultSeatConfig, getModel } from '$data/aircraft';
import { availableGatesAt } from '$db/repo';
import {
	acquireAircraft,
	addScheduleEntry,
	buyAudit,
	buyGate,
	companyFleet,
	companyGates,
	createCompany,
	companyGatesAt,
	createRoute,
	disposeAircraft,
	hasAudit,
	hireWorkers,
	previewRoute,
	settleIncident
} from '$db/repo';
import {
	EMPLOYEES_PER_GATE,
	EMPLOYEES_PER_ROUTE,
	HIRING_FEE,
	PLAYER_HOLDER_ID,
	STARTING_CASH,
	TOTAL_SHARES,
	db,
	pairKeyOf,
	type Company
} from '$db/schema';
import { getClockOffset, setClockOffset } from './clock';
import { catchUp } from './tick';
import { auditCost } from './audit';

const foundAirline = async (cash = FIXTURE_CASH): Promise<Company> =>
	createCompany({ name: 'Test Air', icao: 'TST', homeIata: 'BCN', cash });

/**
 * Adds a narrowbody able to fly the given distance, based at the airline's home
 * gate. AIRCRAFT_MODELS is ordered by price, so this picks the cheapest fit.
 */
const addAircraft = async (company: Company, minimumRange = 1500) => {
	const gates = await companyGates(company.id);
	const gate = gates[0];
	const model = AIRCRAFT_MODELS.find(
		(candidate) =>
			candidate.range >= minimumRange &&
			candidate.category <= gate.maxCategory &&
			candidate.seats > 100
	);
	if (!model) throw new Error('no suitable model for the test');

	return acquireAircraft({
		companyId: company.id,
		modelId: model.id,
		name: 'Test Bird',
		seats: defaultSeatConfig(model),
		ownership: 'owned',
		homeGateId: gate.key
	});
};

describe('airline simulation', () => {
	describe('WHEN the world is seeded', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should store no stands at all, since they are derived', async () => {
			const stored = await db.gate_ownership.count();
			const ownedByAi = (await db.companies.toArray()).length;

			// Only what the AI carriers bought: a hub plus a stand per route each.
			expect(stored).toBeGreaterThan(0);
			expect(stored).toBeGreaterThanOrEqual(ownedByAi);
			expect(stored).toBeLessThan(TOTAL_GATE_COUNT / 20);
		});

		it('should offer stands at every airport without storing them', async () => {
			const available = await availableGatesAt('LIS');
			const stored = await db.gate_ownership.where('airportIata').equals('LIS').count();

			// Lisbon's stands are derived, so they are on sale even though the database
			// holds at most the handful an airline has actually bought there.
			expect(available.length).toBeGreaterThan(50);
			expect(stored).toBeLessThan(5);
			expect(available.length + stored).toBe(gateCountFor('LIS'));
		});

		it('should create twelve AI airlines with routes and schedules', async () => {
			const aiCompanies = await db.companies.where('controller').equals('ai').toArray();
			const routes = await db.routes.count();
			const entries = await db.schedule_entries.count();

			expect(aiCompanies).toHaveLength(12);
			expect(routes).toBeGreaterThan(10);
			expect(entries).toBeGreaterThan(10);
		});

		it('should give every AI airline its full share register', async () => {
			const companies = await db.companies.toArray();

			for (const company of companies) {
				const holdings = await db.shareholdings.where('companyId').equals(company.id).toArray();
				const total = holdings.reduce((sum, holding) => sum + holding.quantity, 0);

				expect(total).toBe(TOTAL_SHARES);
			}
		});

		it('should not seed twice', async () => {
			const { seedWorld } = await import('$db/seed');
			const before = await db.gate_ownership.count();

			await seedWorld();

			expect(await db.gate_ownership.count()).toBe(before);
		});
	});

	describe('WHEN an airline is founded', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		const foundOnOpeningBalance = async (): Promise<Company> =>
			createCompany({ name: 'Opening Air', icao: 'OPN', homeIata: 'BCN' });

		it('should start with the opening balance, all shares and one free gate', async () => {
			const company = await foundOnOpeningBalance();
			const gates = await companyGates(company.id);
			const playerShares = await db.shareholdings
				.where('[companyId+holderId]')
				.equals([company.id, PLAYER_HOLDER_ID])
				.first();

			expect(company.cash).toBe(STARTING_CASH);
			expect(playerShares?.quantity).toBe(TOTAL_SHARES);
			expect(gates).toHaveLength(1);
			expect(gates[0].airportIata).toBe('BCN');
		});

		it('should charge nothing for the free home gate but still add its staff', async () => {
			const company = await foundOnOpeningBalance();
			const fresh = await db.companies.get(company.id);
			const records = await db.transaction_records.where('companyId').equals(company.id).toArray();

			expect(fresh?.cash).toBe(STARTING_CASH);
			expect(fresh?.external_workers).toBe(EMPLOYEES_PER_GATE);
			expect(records).toHaveLength(0);
		});

		it('should give each airline its own slug', async () => {
			const first = await foundAirline();
			const second = await createCompany({ name: 'Test Air', icao: 'TS2', homeIata: 'MAD' });

			expect(second.slug).not.toBe(first.slug);
		});
	});

	describe('WHEN aircraft are acquired', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should deliver the first aircraft instantly and later ones with a delay', async () => {
			const company = await foundAirline();

			const first = await addAircraft(company);
			const second = await addAircraft(company);

			expect(first.status).toBe('idle');
			expect(second.status).toBe('delivering');
			expect(second.deliveryAt).toBeGreaterThan(second.orderedAt);
			expect(second.deliveryAt - second.orderedAt).toBeLessThanOrEqual(60 * 60_000);
		});

		it('should charge the list price and add the crew to external workers', async () => {
			const company = await foundAirline();

			const aircraft = await addAircraft(company);

			const model = getModel(aircraft.modelId);
			const fresh = await db.companies.get(company.id);

			expect(fresh?.cash).toBe(company.cash - model.price);
			expect(fresh?.external_workers).toBe(EMPLOYEES_PER_GATE + model.employees);
		});

		it('should refuse a gate that cannot take the aircraft category', async () => {
			const company = await foundAirline();
			const gates = await companyGates(company.id);
			const tooBig = AIRCRAFT_MODELS.find(
				(model) => model.category > gates[0].maxCategory && model.price < company.cash
			);
			if (!tooBig) return;

			await expect(
				acquireAircraft({
					companyId: company.id,
					modelId: tooBig.id,
					name: 'Too big',
					seats: defaultSeatConfig(tooBig),
					ownership: 'owned',
					homeGateId: gates[0].key
				})
			).rejects.toThrow('only accepts category');
		});

		it('should deliver a pending aircraft once its hour has passed', async () => {
			const company = await foundAirline();
			await addAircraft(company);
			const pending = await addAircraft(company);

			await advanceHours(2);

			const delivered = await db.aircraft.get(pending.id);
			expect(delivered?.status).toBe('idle');
		});
	});

	describe('WHEN a route is opened', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should buy the destination gate as part of the set-up cost', async () => {
			const company = await foundAirline();
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');

			const preview = await previewRoute(company.id, homeGate.key, targetGate.key);
			await createRoute(company.id, homeGate.key, targetGate.key, {
				economy: 100,
				business: 250,
				first: 500
			});

			const fresh = await db.companies.get(company.id);
			const boughtGate = await db.gate_ownership.get(targetGate.key);

			expect(preview.setupCost).toBe(targetGate.price);
			expect(boughtGate?.companyId).toBe(company.id);
			expect(fresh?.cash).toBe(company.cash - targetGate.price);
			expect(fresh?.external_workers).toBe(
				EMPLOYEES_PER_GATE * 2 + EMPLOYEES_PER_ROUTE
			);
		});

		it('should compute a real-world distance', async () => {
			const company = await foundAirline();
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');

			const preview = await previewRoute(company.id, homeGate.key, targetGate.key);

			// BCN–MAD is about 480 km.
			expect(preview.distanceKm).toBeGreaterThan(450);
			expect(preview.distanceKm).toBeLessThan(520);
		});

		it('should reject a duplicate route', async () => {
			const company = await foundAirline();
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');

			await createRoute(company.id, homeGate.key, targetGate.key, {
				economy: 100,
				business: 250,
				first: 500
			});

			await expect(previewRoute(company.id, homeGate.key, targetGate.key)).resolves.toMatchObject({
				alreadyOperated: true
			});
		});
	});

	describe('WHEN a route audit is bought', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should charge once and stay available afterwards', async () => {
			const company = await foundAirline();
			const pairKey = pairKeyOf('BCN', 'MAD');
			const cost = auditCost(company.id, pairKey);

			await buyAudit(company.id, pairKey, cost);
			await buyAudit(company.id, pairKey, cost);

			const fresh = await db.companies.get(company.id);
			const audits = await db.route_audits.where('companyId').equals(company.id).count();

			expect(await hasAudit(company.id, pairKey)).toBe(true);
			expect(audits).toBe(1);
			expect(fresh?.cash).toBe(company.cash - cost);
		});

		it('should quote a stable price inside the 30k–1M band', async () => {
			const company = await foundAirline();
			const pairKey = pairKeyOf('BCN', 'MAD');

			const first = auditCost(company.id, pairKey);
			const second = auditCost(company.id, pairKey);

			expect(first).toBe(second);
			expect(first).toBeGreaterThanOrEqual(30_000);
			expect(first).toBeLessThanOrEqual(1_000_000);
		});

		it('should not leak an audit to another airline', async () => {
			const first = await foundAirline();
			const second = await createCompany({ name: 'Other Air', icao: 'OTH', homeIata: 'MAD' });
			const pairKey = pairKeyOf('BCN', 'MAD');

			await buyAudit(first.id, pairKey, auditCost(first.id, pairKey));

			expect(await hasAudit(second.id, pairKey)).toBe(false);
		});
	});

	const setUpFlyableRoute = async () => {
		const company = await foundAirline();
		const aircraft = await addAircraft(company);
		const [homeGate] = await companyGates(company.id);
		const [targetGate] = await availableGatesAt('MAD');

		const route = await createRoute(company.id, homeGate.key, targetGate.key, {
			economy: 120,
			business: 320,
			first: 620
		});

		return { company, aircraft, route };
	};

	/**
	 * One week flown once, shared by the assertions below. Two legs a day in each direction is
	 * a superset of what any single one of them needs, and all of them only read the flights
	 * and ledger rows afterwards — a test that writes belongs in a sibling block.
	 */
	describe('WHEN scheduled flights have come round', () => {
		let flownCompanyId = 0;
		let flownAircraftId = 0;

		beforeAll(async () => {
			await freshWorld();
			const { company, route } = await setUpFlyableRoute();
			const fleet = await companyFleet(company.id);
			flownCompanyId = company.id;
			flownAircraftId = fleet[0].id;

			for (let day = 0; day < 7; day += 1) {
				await addScheduleEntry(company.id, fleet[0].id, route.id, day, 4);
				await addScheduleEntry(company.id, fleet[0].id, route.id, day, 12);
			}

			await advanceHours(24 * 7);
		});

		const flownFlights = async () =>
			(await db.flights.where('companyId').equals(flownCompanyId).toArray()).sort(
				(left, right) => left.departAt - right.departAt
			);

		it('should operate the flight, bank the fares and bill fuel and airport charges', async () => {
			const flights = await flownFlights();
			const records = await db.transaction_records
				.where('companyId')
				.equals(flownCompanyId)
				.toArray();

			expect(flights.length).toBeGreaterThan(0);
			expect(records.some((record) => record.category === 'fuel')).toBe(true);
			expect(records.some((record) => record.category === 'airport_tax')).toBe(true);
			expect(records.some((record) => record.category === 'ticket_sales')).toBe(true);
		});

		it('should carry passengers within the installed seat count', async () => {
			const aircraft = await db.aircraft.get(flownAircraftId);
			const flights = await flownFlights();

			expect(flights.length).toBeGreaterThan(0);

			for (const flight of flights) {
				expect(flight.pax.economy).toBeLessThanOrEqual(aircraft!.seats.economy);
				expect(flight.pax.business).toBeLessThanOrEqual(aircraft!.seats.business);
				expect(flight.pax.first).toBeLessThanOrEqual(aircraft!.seats.first);
			}
		});

		it('should accumulate distance on the airframe', async () => {
			const flown = await db.aircraft.get(flownAircraftId);

			expect(flown!.totalKm).toBeGreaterThan(0);
		});

		it('should alternate out and back on consecutive legs of one route', async () => {
			const flights = await flownFlights();

			expect(flights.length).toBeGreaterThanOrEqual(2);
			expect(flights[0].fromIata).toBe('BCN');
			expect(flights[0].toIata).toBe('MAD');
			expect(flights[1].fromIata).toBe('MAD');
			expect(flights[1].toIata).toBe('BCN');
		});

		it('should charge the departure fees of the airport each leg actually leaves', async () => {
			const charges = await db.transaction_records
				.where('companyId')
				.equals(flownCompanyId)
				.filter((record) => record.category === 'airport_tax')
				.toArray();

			expect(charges.some((record) => record.description.startsWith('BCN'))).toBe(true);
			expect(charges.some((record) => record.description.startsWith('MAD'))).toBe(true);
		});
	});

	describe('WHEN a leg cannot be flown', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should skip a leg on a route that does not touch where the aircraft is', async () => {
			const { company } = await setUpFlyableRoute();
			const fleet = await companyFleet(company.id);
			const [homeGate] = await companyGates(company.id);
			const [lisbonGate] = await availableGatesAt('LHR');

			// A second route away from the hub, then a leg on it while the aircraft is
			// stranded at the far end of the first route.
			const other = await createRoute(company.id, homeGate.key, lisbonGate.key, {
				economy: 150,
				business: 400,
				first: 800
			});

			await addScheduleEntry(company.id, fleet[0].id, other.id, 0, 2);
			await advanceHours(24 * 7);

			const flights = await db.flights.where('companyId').equals(company.id).toArray();
			const strandedLegs = flights.filter(
				(flight) => flight.fromIata !== 'BCN' && flight.fromIata !== 'LHR'
			);

			expect(strandedLegs).toEqual([]);
		});

		it('should refuse a second route on a pair already operated in reverse', async () => {
			const { company } = await setUpFlyableRoute();
			const [homeGate] = await companyGates(company.id);
			const madridGate = (await companyGatesAt(company.id, 'MAD'))[0];

			const reversed = await previewRoute(company.id, madridGate.key, homeGate.key);

			expect(reversed.alreadyOperated).toBe(true);
			await expect(
				createRoute(company.id, madridGate.key, homeGate.key, {
					economy: 100,
					business: 200,
					first: 400
				})
			).rejects.toThrow('already operate');
		});
	});

	describe('WHEN a day closes', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should charge wages for external and hired workers', async () => {
			const company = await foundAirline();
			await addAircraft(company);

			await advanceHours(48);

			const wages = await db.transaction_records
				.where('companyId')
				.equals(company.id)
				.filter((record) => record.category === 'wages')
				.toArray();

			expect(wages.length).toBeGreaterThan(0);
			expect(wages.every((record) => record.amount < 0)).toBe(true);
		});

		it('should let AI airlines act exactly once per day', async () => {
			const before = await db.companies.where('controller').equals('ai').toArray();
			const startDays = before.map((company) => company.lastAiDay);

			await advanceHours(24 * 3);

			const after = await db.companies.where('controller').equals('ai').toArray();
			for (const [index, company] of after.entries()) {
				expect(company.lastAiDay).toBeGreaterThan(startDays[index]);
			}
		});

		// The payroll decisions below come out of `runAiDay`, so they are driven directly
		// rather than by moving the clock — advancing it would replay every scheduled
		// departure in the world to arrive at the same choices.
		it('should let AI airlines take some of their externals onto the payroll', async () => {
			await runAiDays(21);

			const carriers = await db.companies.where('controller').equals('ai').toArray();
			const hired = carriers.reduce((sum, carrier) => sum + carrier.hired_workers, 0);
			const fees = await db.transaction_records
				.where('category')
				.equals('hiring_fee')
				.toArray();

			expect(hired).toBeGreaterThan(0);
			expect(fees.length).toBeGreaterThan(0);
			expect(fees.every((record) => record.amount < 0)).toBe(true);
		});

		it('should have some AI airlines convert eagerly and others hardly at all', async () => {
			await runAiDays(42);

			const carriers = await db.companies.where('controller').equals('ai').toArray();
			const staffed = carriers.filter(
				(carrier) => carrier.hired_workers + carrier.external_workers > 0
			);
			const shares = staffed.map(
				(carrier) =>
					carrier.hired_workers / (carrier.hired_workers + carrier.external_workers)
			);

			expect(Math.max(...shares)).toBeGreaterThan(0.5);
			expect(Math.min(...shares)).toBeLessThan(0.2);
		});

		it('should leave the airlines that never hire on agency staff for good', async () => {
			await runAiDays(56);

			const carriers = await db.companies.where('controller').equals('ai').toArray();
			const neverHires = carriers.filter(
				(carrier) => hiringDispositionOf(carrier).reviewChance === 0
			);
			const everyoneElse = carriers.filter(
				(carrier) => hiringDispositionOf(carrier).reviewChance > 0
			);

			expect(neverHires.length).toBeGreaterThan(0);
			for (const carrier of neverHires) {
				expect(carrier.hired_workers).toBe(0);
			}
			expect(everyoneElse.some((carrier) => carrier.hired_workers > 0)).toBe(true);
		});

		it('should never hire an AI airline past the externals it has', async () => {
			await runAiDays(21);

			const carriers = await db.companies.where('controller').equals('ai').toArray();
			const fees = await db.transaction_records.where('category').equals('hiring_fee').toArray();
			const paidFor = fees.reduce((sum, record) => sum + -record.amount / HIRING_FEE, 0);
			const hired = carriers.reduce((sum, carrier) => sum + carrier.hired_workers, 0);

			// Hiring only ever moves somebody off the agency payroll, and every move is paid
			// for — so the roster cannot hold anyone a fee was not charged for.
			expect(hired).toBe(paidFor);
			for (const carrier of carriers) {
				expect(carrier.external_workers).toBeGreaterThanOrEqual(0);
				expect(carrier.hired_workers).toBeGreaterThanOrEqual(0);
			}
		});

		it('should not double-charge when the catch-up runs again with no time passing', async () => {
			const company = await foundAirline();
			await addAircraft(company);
			await advanceHours(48);

			const before = await db.transaction_records.where('companyId').equals(company.id).count();
			const cashBefore = (await db.companies.get(company.id))!.cash;

			await catchUp();
			await catchUp();

			const after = await db.transaction_records.where('companyId').equals(company.id).count();
			const cashAfter = (await db.companies.get(company.id))!.cash;

			expect(after).toBe(before);
			expect(cashAfter).toBe(cashBefore);
		});

		it('should keep the ledger and the cash balance in step', async () => {
			const company = await foundAirline();
			await addAircraft(company);
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');
			const route = await createRoute(company.id, homeGate.key, targetGate.key, {
				economy: 120,
				business: 320,
				first: 620
			});
			const fleet = await companyFleet(company.id);
			await addScheduleEntry(company.id, fleet[0].id, route.id, 0, 6);

			await advanceHours(24 * 5);

			const records = await db.transaction_records.where('companyId').equals(company.id).toArray();
			const ledgerTotal = records.reduce((sum, record) => sum + record.amount, 0);
			const fresh = await db.companies.get(company.id);

			expect(fresh!.cash).toBe(company.cash + ledgerTotal);
		});
	});

	describe('WHEN maintenance falls due', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should service an AI carrier’s overdue airframe without being asked', async () => {
			const aiCompany = (await db.companies.where('controller').equals('ai').toArray())[0];
			const fleet = await db.aircraft.where('companyId').equals(aiCompany.id).toArray();

			// Push the whole AI fleet just past its service interval.
			for (const aircraft of fleet) {
				const model = getModel(aircraft.modelId);
				await db.aircraft.update(aircraft.id, {
					kmSinceMaintenance: model.maintenanceIntervalKm + 500
				});
			}

			await advanceHours(24 * 7);

			const checks = await db.transaction_records
				.where('companyId')
				.equals(aiCompany.id)
				.filter((record) => record.category === 'maintenance')
				.toArray();

			expect(checks.length).toBeGreaterThan(0);
		});

		it('should leave a player’s overdue airframe alone until the player acts', async () => {
			const company = await foundAirline();
			const aircraft = await addAircraft(company);
			const model = getModel(aircraft.modelId);
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');

			const route = await createRoute(company.id, homeGate.key, targetGate.key, {
				economy: 120,
				business: 320,
				first: 620
			});

			// One leg short of the interval, so it goes overdue in flight.
			await db.aircraft.update(aircraft.id, {
				kmSinceMaintenance: model.maintenanceIntervalKm - 10
			});
			await addScheduleEntry(company.id, aircraft.id, route.id, 0, 6);

			await advanceHours(24 * 7);

			const checks = await db.transaction_records
				.where('companyId')
				.equals(company.id)
				.filter((record) => record.category === 'maintenance')
				.count();
			const overdue = await db.aircraft.get(aircraft.id);

			expect(checks).toBe(0);
			expect(overdue!.kmSinceMaintenance).toBeGreaterThan(model.maintenanceIntervalKm);
		});

		it('should reset the odometer when the check finishes', async () => {
			const company = await foundAirline();
			const aircraft = await addAircraft(company);
			const model = getModel(aircraft.modelId);

			await db.aircraft.update(aircraft.id, {
				status: 'maintenance',
				kmSinceMaintenance: model.maintenanceIntervalKm + 5_000,
				maintenanceUntil: Date.now() + getClockOffset() + 3_600_000
			});

			await advanceHours(model.maintenanceHours + 2);

			const serviced = await db.aircraft.get(aircraft.id);
			expect(serviced!.status).toBe('idle');
			expect(serviced!.kmSinceMaintenance).toBe(0);
		});
	});

	describe('WHEN an accident happens', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should open a claim that can be settled, grounding the aircraft for repairs', async () => {
			const company = await foundAirline();
			const aircraft = await addAircraft(company);

			const incidentId = await db.incidents.add({
				companyId: company.id,
				aircraftId: aircraft.id,
				aircraftName: aircraft.name,
				flightId: null,
				at: Date.now(),
				passengers: 120,
				baseAmount: 4_000_000,
				status: 'pending',
				outcome: null,
				finalAmount: null,
				resolvedAt: null
			});

			const cashBefore = (await db.companies.get(company.id))!.cash;
			await settleIncident(incidentId);

			const incident = await db.incidents.get(incidentId);
			const grounded = await db.aircraft.get(aircraft.id);
			const cashAfter = (await db.companies.get(company.id))!.cash;

			expect(incident!.status).toBe('settled');
			expect(cashAfter).toBe(cashBefore - 4_000_000);
			expect(grounded!.status).toBe('maintenance');
		});
	});

	describe('WHEN workers are hired', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should move them off the external payroll and charge the fee', async () => {
			const company = await foundAirline();
			await addAircraft(company);
			const before = await db.companies.get(company.id);
			const toHire = 5;

			await hireWorkers(company.id, toHire);

			const after = await db.companies.get(company.id);

			expect(after!.hired_workers).toBe(toHire);
			expect(after!.external_workers).toBe(before!.external_workers - toHire);
			expect(after!.cash).toBe(before!.cash - toHire * 275);
		});

		it('should clamp an oversized request to the externals actually available', async () => {
			const company = await foundAirline();

			await hireWorkers(company.id, 10_000);

			const after = await db.companies.get(company.id);
			expect(after!.hired_workers).toBe(EMPLOYEES_PER_GATE);
			expect(after!.external_workers).toBe(0);
		});

		it('should refuse to hire when there are no externals left', async () => {
			const company = await foundAirline();
			await hireWorkers(company.id, EMPLOYEES_PER_GATE);

			await expect(hireWorkers(company.id, 1)).rejects.toThrow('No external workers');
		});
	});

	describe('WHEN an aircraft is disposed of', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should pay out, drop its schedule and take its crew off the payroll', async () => {
			const company = await foundAirline();
			const aircraft = await addAircraft(company);
			const model = getModel(aircraft.modelId);
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');
			const route = await createRoute(company.id, homeGate.key, targetGate.key, {
				economy: 120,
				business: 320,
				first: 620
			});
			await addScheduleEntry(company.id, aircraft.id, route.id, 0, 6);

			const before = await db.companies.get(company.id);
			const proceeds = await disposeAircraft(aircraft.id);
			const after = await db.companies.get(company.id);

			expect(proceeds).toBeGreaterThan(0);
			expect(proceeds).toBeLessThan(model.price);
			expect(after!.cash).toBe(before!.cash + proceeds);
			expect(after!.external_workers).toBe(before!.external_workers - model.employees);
			expect(await db.aircraft.get(aircraft.id)).toBeUndefined();
			expect(await db.schedule_entries.where('aircraftId').equals(aircraft.id).count()).toBe(0);
		});

		it('should pay nothing for handing a leased airframe back', async () => {
			const company = await foundAirline();
			const gates = await companyGates(company.id);
			const model = AIRCRAFT_MODELS.find(
				(candidate) => candidate.category <= gates[0].maxCategory && candidate.price < 20_000_000
			);
			if (!model) throw new Error('no model');

			const leased = await acquireAircraft({
				companyId: company.id,
				modelId: model.id,
				name: 'Leased One',
				seats: defaultSeatConfig(model),
				ownership: 'leased',
				homeGateId: gates[0].key
			});

			const before = await db.companies.get(company.id);
			const proceeds = await disposeAircraft(leased.id);
			const after = await db.companies.get(company.id);

			expect(proceeds).toBe(0);
			expect(after!.cash).toBe(before!.cash);
			expect(await db.aircraft.get(leased.id)).toBeUndefined();
		});

		it('should refuse while the aircraft is in the air', async () => {
			const company = await foundAirline();
			const aircraft = await addAircraft(company);
			await db.aircraft.update(aircraft.id, { status: 'flying' });

			await expect(disposeAircraft(aircraft.id)).rejects.toThrow('landed');
		});
	});

	describe('WHEN a gate is bought', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should refuse a stand that already belongs to somebody', async () => {
			const company = await foundAirline();
			const [gate] = await availableGatesAt('MAD');

			await buyGate(company.id, gate.key);

			const second = await createCompany({ name: 'Rival Air', icao: 'RVL', homeIata: 'LHR' });
			await expect(buyGate(second.id, gate.key)).rejects.toThrow('already belongs');
		});
	});
});
