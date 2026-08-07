import { beforeEach, describe, expect, it } from 'vitest';
import { freshWorld } from '$engine/testing/world';
import { AIRCRAFT_MODELS, defaultSeatConfig } from '$data/aircraft';
import { getClockOffset, setClockOffset } from '$engine/clock';
import {
	acquireAircraft,
	addScheduleEntry,
	availableGatesAt,
	companyGates,
	createCompany,
	createRoute,
	openTakeoverBid
} from './repo';
import { PLAYER_HOLDER_ID, STARTING_CASH, db } from './schema';
import {
	SAVE_FORMAT,
	SAVE_VERSION,
	SaveFileError,
	exportSave,
	importSave,
	parseSave
} from './backup';

const buildWorld = async () => {
	const company = await createCompany({ name: 'Backup Air', icao: 'BKP', homeIata: 'BCN' });
	const [homeGate] = await companyGates(company.id);

	const model = AIRCRAFT_MODELS.find(
		(candidate) =>
			candidate.category <= homeGate.maxCategory && candidate.price < STARTING_CASH / 4
	);
	if (!model) throw new Error('no model');

	const aircraft = await acquireAircraft({
		companyId: company.id,
		modelId: model.id,
		name: 'Backup One',
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
	await addScheduleEntry(company.id, aircraft.id, route.id, 0, 6);

	return { company, aircraft, route };
};

describe('save files', () => {
	beforeEach(async () => {
		await freshWorld();
	});

	describe('WHEN a world is exported', () => {
		it('should be stamped so it can be recognised again', async () => {
			const save = parseSave(await exportSave());

			expect(save.format).toBe(SAVE_FORMAT);
			expect(save.version).toBe(SAVE_VERSION);
			expect(save.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it('should carry every table, the seeded world included', async () => {
			const { aircraft } = await buildWorld();

			const save = parseSave(await exportSave());

			// The world ships with twelve AI carriers, so these counts cover them too. This
			// number is also the guard that broker desks stayed out of the companies table:
			// everything that enumerates companies assumes every row operates an airline.
			expect(save.tables.companies.length).toBe(13);
			expect(save.tables.brokers.length).toBe(4);
			expect(save.tables.routes.length).toBeGreaterThan(0);
			expect(save.tables.schedule_entries.length).toBeGreaterThan(0);
			expect(save.tables.game_state.length).toBe(1);
			expect(save.tables.aircraft).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: aircraft.id, name: 'Backup One' })])
			);
		});
	});

	describe('WHEN a save is imported', () => {
		it('should restore the airline, its fleet and its timetable exactly', async () => {
			const { company, aircraft, route } = await buildWorld();
			// Read the company back after the fleet and route were paid for, so the
			// comparison is against what was actually exported.
			const exported = await db.companies.get(company.id);
			const contents = await exportSave();

			// Wipe to a brand-new world, then restore the save over the top.
			await freshWorld();
			expect(await db.companies.where('icao').equals('BKP').count()).toBe(0);

			await importSave(contents);

			const restoredCompany = await db.companies.get(company.id);
			const restoredAircraft = await db.aircraft.get(aircraft.id);
			const restoredRoute = await db.routes.get(route.id);
			const entries = await db.schedule_entries.where('aircraftId').equals(aircraft.id).toArray();

			expect(restoredCompany).toEqual(exported);
			expect(restoredAircraft!.name).toBe('Backup One');
			expect(restoredAircraft!.seats).toEqual(aircraft.seats);
			expect(restoredRoute!.prices).toEqual(route.prices);
			expect(entries).toHaveLength(1);
			expect(entries[0].startHour).toBe(6);
		});

		it('should restore the broker desks with their identities intact', async () => {
			const before = await db.brokers.toArray();
			const contents = await exportSave();

			await freshWorld();
			await importSave(contents);

			expect(await db.brokers.toArray()).toEqual(before);
		});

		it('should restore an open takeover offer', async () => {
			const { company } = await buildWorld();
			const target = (await db.companies.where('controller').equals('ai').toArray())[0];
			await db.companies.update(company.id, { cash: 500_000_000 });
			await openTakeoverBid({
				targetCompanyId: target.id,
				bidderHolderId: PLAYER_HOLDER_ID,
				bidderCompanyId: company.id,
				pricePerShare: 9_000,
				sharesSought: 1_501,
				closesDay: 99
			});
			const before = await db.takeover_bids.toArray();
			const contents = await exportSave();

			await freshWorld();
			await importSave(contents);

			expect(await db.takeover_bids.toArray()).toEqual(before);
		});

		it('should import a save written before takeover offers existed', async () => {
			const save = parseSave(await exportSave());
			delete save.tables.takeover_bids;

			await importSave(JSON.stringify(save));

			expect(await db.takeover_bids.count()).toBe(0);
		});

		it('should put the desks back when restoring a save written before they existed', async () => {
			const save = parseSave(await exportSave());
			delete save.tables.brokers;

			await importSave(JSON.stringify(save));

			const restored = await db.brokers.toArray();
			expect(restored).toHaveLength(4);
			expect(restored.map((broker) => broker.key)).toContain('ashgrove');
		});

		it('should leave nothing of the world it replaced', async () => {
			const contents = await exportSave();
			await freshWorld();
			await createCompany({ name: 'Ghost Air', icao: 'GHO', homeIata: 'MAD' });

			await importSave(contents);

			expect(await db.companies.where('icao').equals('GHO').count()).toBe(0);
		});

		it('should restore the world clock offset', async () => {
			setClockOffset(72 * 3_600_000);
			await db.game_state.update(1, { clockOffsetMs: 72 * 3_600_000 });
			const contents = await exportSave();

			await freshWorld();
			expect(getClockOffset()).toBe(0);

			await importSave(contents);

			expect(getClockOffset()).toBe(72 * 3_600_000);
		});

		it('should survive a second round trip unchanged', async () => {
			await buildWorld();
			const first = await exportSave();

			await importSave(first);
			const second = await exportSave();

			expect(parseSave(second).tables).toEqual(parseSave(first).tables);
		});
	});

	describe('WHEN a version 1 save is imported', () => {
		/** A save from the build that stored every stand and referenced them by row id. */
		const legacySave = () =>
			JSON.stringify({
				format: SAVE_FORMAT,
				version: 1,
				exportedAt: '2026-01-01T00:00:00.000Z',
				tables: {
					game_state: [
						{
							id: 1,
							createdAt: 1,
							lastTickAt: 1,
							lastProcessedDay: 20_000,
							fuelPricePerLitre: 0.9,
							seed: 1,
							seededAt: 1,
							clockOffsetMs: 0
						}
					],
					companies: [
						{
							id: 1,
							slug: 'old-air',
							name: 'Old Air',
							icao: 'OLD',
							controller: 'player',
							cash: 500_000,
							homeIata: 'BCN',
							hired_workers: 0,
							external_workers: 10,
							marketMultiplier: 1,
							firstAircraftDelivered: 1,
							lastAiDay: 0,
							createdAt: 1,
							colour: '#00d09c'
						}
					],
					gates: [
						{
							id: 11,
							airportIata: 'BCN',
							number: 'A1',
							maxCategory: 8,
							price: 1,
							ownerCompanyId: 1,
							purchasedAt: 5
						},
						{
							id: 12,
							airportIata: 'MAD',
							number: 'B3',
							maxCategory: 10,
							price: 1,
							ownerCompanyId: 1,
							purchasedAt: 6
						},
						{
							id: 13,
							airportIata: 'BCN',
							number: 'A2',
							maxCategory: 6,
							price: 1,
							ownerCompanyId: 0,
							purchasedAt: null
						}
					],
					aircraft: [
						{
							id: 1,
							companyId: 1,
							modelId: 200,
							name: 'Old One',
							registration: 'OL-A1',
							ownership: 'owned',
							leaseDailyRate: 0,
							seats: { economy: 20, business: 0, first: 0 },
							status: 'idle',
							orderedAt: 1,
							deliveryAt: 1,
							homeGateId: 11,
							currentIata: 'BCN',
							totalKm: 0,
							kmSinceMaintenance: 0,
							maintenanceUntil: null,
							purchasePrice: 1,
							createdAt: 1
						}
					],
					routes: [
						{
							id: 1,
							companyId: 1,
							fromGateId: 11,
							toGateId: 12,
							fromIata: 'BCN',
							toIata: 'MAD',
							distanceKm: 483,
							prices: { economy: 100, business: 250, first: 500 },
							createdAt: 1
						}
					],
					shareholdings: [{ id: 1, companyId: 1, holderId: 'p:1', quantity: 3000 }],
					share_listings: [],
					share_trades: [],
					route_audits: [],
					schedule_entries: [],
					flights: [],
					transaction_records: [],
					incidents: []
				}
			});

		it('should accept it rather than rejecting the version', async () => {
			await expect(importSave(legacySave())).resolves.toBeUndefined();
		});

		it('should turn its stand rows into ownership keyed by gate', async () => {
			await importSave(legacySave());

			const ownership = await db.gate_ownership.toArray();

			expect(ownership.map((row) => row.gateKey).sort()).toEqual(['BCN-A1', 'MAD-B3']);
			expect(ownership.every((row) => row.companyId === 1)).toBe(true);
		});

		it('should repoint the aircraft and route at their stands', async () => {
			await importSave(legacySave());

			const aircraft = await db.aircraft.get(1);
			const route = await db.routes.get(1);

			expect(aircraft?.homeGateId).toBe('BCN-A1');
			expect(route?.fromGateId).toBe('BCN-A1');
			expect(route?.toGateId).toBe('MAD-B3');
		});

		it('should leave the airline reading its gates as usual', async () => {
			await importSave(legacySave());

			const gates = await companyGates(1);

			expect(gates.map((gate) => gate.key)).toEqual(['BCN-A1', 'MAD-B3']);
		});

		it('should offer airports that world never had', async () => {
			await importSave(legacySave());

			expect((await availableGatesAt('LIS')).length).toBeGreaterThan(0);
		});
	});

	describe('WHEN the file is not a save', () => {
		it.each`
			contents                    | message
			${'not json at all'}        | ${'not valid JSON'}
			${'{"format":"something"}'} | ${'not an Airline Manager Simulator save'}
			${'{"format":"airline-manager-simulator-save","version":99}'} | ${'Unsupported save version'}
			${'{"format":"airline-manager-simulator-save","version":2}'} | ${'no table data'}
		`('should refuse it with "$message"', ({ contents, message }) => {
			expect(() => parseSave(contents as string)).toThrow(message as string);
		});

		it('should refuse it with a typed error', () => {
			expect(() => parseSave('nope')).toThrow(SaveFileError);
		});

		it('should leave the current world untouched when a file is rejected', async () => {
			const { company } = await buildWorld();

			await expect(importSave('rubbish')).rejects.toThrow(SaveFileError);

			expect(await db.companies.get(company.id)).toBeDefined();
		});
	});
});
