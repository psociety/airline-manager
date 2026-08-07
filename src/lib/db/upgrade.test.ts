import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIRPORTS } from '$data/airports';
import { gateKey } from '$data/gates';
import { setClockOffset } from '$engine/clock';
import { availableGatesAt, companyGates } from './repo';
import { db } from './schema';

const DATABASE_NAME = 'airline-manager-simulator';

/**
 * The pre-refactor schema: every stand was a row, and aircraft and routes pointed at
 * those rows by numeric id. Written with a bare Dexie so the real database can then open
 * it and run its migration, exactly as it will in a player's browser.
 */
const writeLegacyWorld = async (): Promise<void> => {
	const legacy = new Dexie(DATABASE_NAME);
	legacy.version(1).stores({
		game_state: 'id',
		companies: '++id, &slug, name, icao, controller, lastAiDay',
		shareholdings: '++id, companyId, holderId, [companyId+holderId]',
		share_listings: '++id, companyId, sellerId, pricePerShare',
		share_trades: '++id, companyId, at',
		gates: '++id, airportIata, ownerCompanyId, [airportIata+number], [ownerCompanyId+airportIata]',
		aircraft: '++id, companyId, status, deliveryAt, [companyId+status]',
		routes: '++id, companyId, fromIata, toIata, [fromIata+toIata], [companyId+fromIata]',
		route_audits: '++id, companyId, &[companyId+pairKey]',
		schedule_entries: '++id, companyId, aircraftId, routeId, [aircraftId+dayOfWeek]',
		flights: '++id, companyId, aircraftId, routeId, departAt, arriveAt, status, [companyId+status]',
		transaction_records: '++id, companyId, at, day, category, [companyId+day]',
		incidents: '++id, companyId, status, at, [companyId+status]'
	});
	await legacy.open();

	await legacy.table('game_state').add({
		id: 1,
		createdAt: 1,
		lastTickAt: 1,
		lastProcessedDay: 20_000,
		fuelPricePerLitre: 0.85,
		seed: 1,
		seededAt: 1,
		clockOffsetMs: 0
	});
	await legacy.table('companies').add({
		id: 1,
		slug: 'legacy-air',
		name: 'Legacy Air',
		icao: 'LGY',
		controller: 'player',
		cash: 1_000_000,
		homeIata: 'BCN',
		hired_workers: 0,
		external_workers: 20,
		marketMultiplier: 1,
		firstAircraftDelivered: 1,
		lastAiDay: 0,
		createdAt: 1,
		colour: '#00d09c'
	});

	// Two owned stands and one unowned, which the migration must discard.
	const homeGateId = (await legacy.table('gates').add({
		airportIata: 'BCN',
		number: 'A1',
		maxCategory: 8,
		price: 5_000_000,
		ownerCompanyId: 1,
		purchasedAt: 10
	})) as number;
	const awayGateId = (await legacy.table('gates').add({
		airportIata: 'MAD',
		number: 'B3',
		maxCategory: 10,
		price: 6_000_000,
		ownerCompanyId: 1,
		purchasedAt: 11
	})) as number;
	await legacy.table('gates').add({
		airportIata: 'BCN',
		number: 'A2',
		maxCategory: 6,
		price: 4_000_000,
		ownerCompanyId: 0,
		purchasedAt: null
	});

	await legacy.table('aircraft').add({
		id: 1,
		companyId: 1,
		modelId: 200,
		name: 'Legacy One',
		registration: 'LG-A1',
		ownership: 'owned',
		leaseDailyRate: 0,
		seats: { economy: 20, business: 0, first: 0 },
		status: 'idle',
		orderedAt: 1,
		deliveryAt: 1,
		homeGateId,
		currentIata: 'BCN',
		totalKm: 1000,
		kmSinceMaintenance: 500,
		maintenanceUntil: null,
		purchasePrice: 3_800_000,
		createdAt: 1
	});
	await legacy.table('routes').add({
		id: 1,
		companyId: 1,
		fromGateId: homeGateId,
		toGateId: awayGateId,
		fromIata: 'BCN',
		toIata: 'MAD',
		distanceKm: 483,
		prices: { economy: 100, business: 250, first: 500 },
		createdAt: 1
	});

	legacy.close();
};

describe('upgrading a pre-refactor database', () => {
	beforeEach(async () => {
		setClockOffset(0);
		if (db.isOpen()) db.close();
		await Dexie.delete(DATABASE_NAME);
		await writeLegacyWorld();
	});

	afterEach(async () => {
		if (db.isOpen()) db.close();
		await Dexie.delete(DATABASE_NAME);
	});

	describe('WHEN the database is opened by the current build', () => {
		it('should keep the owned stands and drop the unowned ones', async () => {
			await db.open();

			const ownership = await db.gate_ownership.toArray();

			expect(ownership).toHaveLength(2);
			expect(ownership.map((row) => row.gateKey).sort()).toEqual(['BCN-A1', 'MAD-B3']);
			expect(ownership.every((row) => row.companyId === 1)).toBe(true);
		});

		it('should carry the purchase dates across', async () => {
			await db.open();

			const home = await db.gate_ownership.get(gateKey('BCN', 'A1'));

			expect(home?.purchasedAt).toBe(10);
		});

		it('should repoint the aircraft at its stand by key', async () => {
			await db.open();

			const aircraft = await db.aircraft.get(1);

			expect(aircraft?.homeGateId).toBe('BCN-A1');
		});

		it('should repoint both ends of the route', async () => {
			await db.open();

			const route = await db.routes.get(1);

			expect(route?.fromGateId).toBe('BCN-A1');
			expect(route?.toGateId).toBe('MAD-B3');
		});

		it('should drop the old table entirely', async () => {
			await db.open();

			expect(db.tables.map((table) => table.name)).not.toContain('gates');
		});

		it('should leave the airline able to read its own gates', async () => {
			await db.open();

			const gates = await companyGates(1);

			expect(gates.map((gate) => gate.key)).toEqual(['BCN-A1', 'MAD-B3']);
			expect(gates[0].maxCategory).toBeGreaterThan(0);
			expect(gates[0].price).toBeGreaterThan(0);
		});

		it('should make the stand it discarded buyable again', async () => {
			await db.open();

			const available = await availableGatesAt('BCN');

			expect(available.some((gate) => gate.number === 'A2')).toBe(true);
			expect(available.some((gate) => gate.number === 'A1')).toBe(false);
		});

		it('should offer stands at airports the old world never knew about', async () => {
			await db.open();

			// Added long after that world was seeded; no migration step is needed for them.
			expect((await availableGatesAt('LIS')).length).toBeGreaterThan(0);
			expect((await availableGatesAt('TLV')).length).toBeGreaterThan(0);
		});

		it('should leave stands for sale at every airport', async () => {
			await db.open();

			const empty: string[] = [];
			for (const airport of AIRPORTS.slice(0, 40)) {
				if ((await availableGatesAt(airport.iataCode)).length === 0) {
					empty.push(airport.iataCode);
				}
			}

			expect(empty).toEqual([]);
		});

		it('should give a world that predates takeover offers an empty table for them', async () => {
			await db.open();

			// The version 6 store is purely additive, so an existing world needs no migration —
			// but it does have to come out the other side able to hold a bid.
			expect(await db.takeover_bids.count()).toBe(0);

			await db.takeover_bids.add({
				targetCompanyId: 1,
				bidderHolderId: 'p:1',
				bidderCompanyId: 1,
				pricePerShare: 9_000,
				sharesSought: 1_501,
				escrow: 9_000 * 1_501,
				openedAt: 1,
				openedDay: 1,
				closesDay: 4,
				status: 'open',
				sharesTendered: 0,
				resolvedAt: null,
				defence: null
			} as never);

			expect(
				await db.takeover_bids.where('[targetCompanyId+status]').equals([1, 'open']).count()
			).toBe(1);
		});

		it('should leave an airline that was never bid for with no lock-out', async () => {
			await db.open();

			const company = await db.companies.get(1);

			expect(company?.bidLockoutUntilDay).toBeUndefined();
		});
	});
});
