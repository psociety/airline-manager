import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceHours, freshWorld, runAiDays, runCeoDays } from './testing/world';
import { getModel } from '$data/aircraft';
import {
	createCompany,
	fillListingAsBroker,
	fireCeo,
	hireCeo,
	listSharesForSale,
	moveShares,
	sharesHeldBy
} from '$db/repo';
import {
	CONTROL_THRESHOLD,
	PLAYER_HOLDER_ID,
	TOTAL_SHARES,
	brokerHolderId,
	companyHolderId,
	db,
	isAiRun,
	type Company
} from '$db/schema';
import { dayIndexOf, gameNow } from './clock';
import { runCeoDay } from './ceo';

const foundAirline = async (): Promise<Company> =>
	createCompany({ name: 'Delegate Air', icao: 'DLG', homeIata: 'BCN', cash: 2_000_000_000 });

const deskHoldings = async () =>
	(await db.shareholdings.toArray()).filter((holding) => holding.holderId.startsWith('b:'));

/** Parks shares in the airline's own treasury so the player is left holding exactly `target`. */
const leavePlayerHolding = async (companyId: number, target: number): Promise<void> => {
	const held = await sharesHeldBy(companyId, PLAYER_HOLDER_ID);
	await moveShares(companyId, PLAYER_HOLDER_ID, companyHolderId(companyId), held - target);
};

const registerTotal = async (companyId: number): Promise<number> =>
	(await db.shareholdings.where('companyId').equals(companyId).toArray()).reduce(
		(sum, holding) => sum + holding.quantity,
		0
	);

describe('chief executives', () => {
	describe('WHEN asking who runs an airline', () => {
		it.each`
			scenario                        | company                                        | expected
			${'nobody owns it'}             | ${{ controller: 'ai' }}                        | ${true}
			${'the player runs it'}         | ${{ controller: 'player' }}                    | ${false}
			${'the player hired a CEO'}     | ${{ controller: 'player', ceoHired: true }}    | ${true}
			${'the CEO was dismissed'}      | ${{ controller: 'player', ceoHired: false }}   | ${false}
			${'an AI carrier has a CEO'}    | ${{ controller: 'ai', ceoHired: true }}        | ${true}
		`('should say $expected when $scenario', ({ company, expected }) => {
			const result = isAiRun(company as Pick<Company, 'controller' | 'ceoHired'>);

			expect(result).toBe(expected);
		});
	});

	describe('WHEN a chief executive is engaged', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should record the hire against today', async () => {
			const company = await foundAirline();

			await hireCeo(company.id);

			const fresh = await db.companies.get(company.id);
			expect(fresh!.ceoHired).toBe(true);
			expect(fresh!.lastCeoDay).toBe(dayIndexOf(gameNow()));
		});

		it('should refuse a second chief executive', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);

			await expect(hireCeo(company.id)).rejects.toThrow('already runs');
		});

		it('should refuse an airline the player does not control', async () => {
			const target = (await db.companies.where('controller').equals('ai').toArray())[0];

			await expect(hireCeo(target.id)).rejects.toThrow('You do not control this airline');
		});

		it('should accept a bare majority and refuse exactly half', async () => {
			const bare = await foundAirline();
			await leavePlayerHolding(bare.id, CONTROL_THRESHOLD + 1);

			await expect(hireCeo(bare.id)).resolves.toBeUndefined();

			const half = await createCompany({ name: 'Half Air', icao: 'HLF', homeIata: 'MAD' });
			await leavePlayerHolding(half.id, CONTROL_THRESHOLD);

			await expect(hireCeo(half.id)).rejects.toThrow('You do not control this airline');
		});

		it('should refuse to dismiss a chief executive that was never hired', async () => {
			const company = await foundAirline();

			await expect(fireCeo(company.id)).rejects.toThrow('No chief executive');
		});

		it('should leave the stake and the controller alone when dismissed', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);

			await fireCeo(company.id);

			const fresh = await db.companies.get(company.id);
			expect(fresh!.ceoHired).toBe(false);
			expect(fresh!.controller).toBe('player');
			expect(await sharesHeldBy(company.id, PLAYER_HOLDER_ID)).toBe(TOTAL_SHARES);
		});
	});

	describe('WHEN a chief executive is running the airline', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should let the AI take its daily turns', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);

			await runAiDays(3);

			const fresh = await db.companies.get(company.id);
			expect(fresh!.lastAiDay).toBeGreaterThan(company.lastAiDay);
		});

		it('should leave the airline alone when nobody was hired', async () => {
			const company = await foundAirline();

			await runAiDays(3);

			const fresh = await db.companies.get(company.id);
			expect(fresh!.lastAiDay).toBe(company.lastAiDay);
		});

		it('should keep the airline in the player’s own list', async () => {
			const { playerCompanies } = await import('$db/repo');
			const company = await foundAirline();
			await hireCeo(company.id);

			const mine = await playerCompanies();

			expect(mine.map((airline) => airline.id)).toContain(company.id);
		});
	});

	/**
	 * One CEO-run airline, left to the AI for three weeks and then only read. Building a fleet
	 * and a network by hand would be both slower and a weaker claim — the point is that the AI
	 * does it unprompted.
	 */
	describe('WHEN the AI has run a delegated airline for weeks', () => {
		let delegatedId = 0;

		beforeAll(async () => {
			await freshWorld();
			const company = await foundAirline();
			delegatedId = company.id;
			await hireCeo(company.id);
			await runAiDays(21);
		});

		it('should have bought aircraft and opened routes by itself', async () => {
			const fleet = await db.aircraft.where('companyId').equals(delegatedId).toArray();
			const routes = await db.routes.where('companyId').equals(delegatedId).count();

			expect(fleet.length).toBeGreaterThan(0);
			expect(routes).toBeGreaterThan(0);
		});

		it('should have taken staff onto the payroll', async () => {
			const fresh = await db.companies.get(delegatedId);

			expect(fresh!.hired_workers + fresh!.external_workers).toBeGreaterThan(0);
		});
	});

	describe('WHEN a delegated airline flies an overdue airframe', () => {
		it('should send it for its check without being asked', async () => {
			await freshWorld();
			const company = await foundAirline();
			await hireCeo(company.id);
			// A week is enough for the AI to buy an airframe and schedule it; the three weeks
			// the block above uses are for the network, which this test does not need.
			await runAiDays(8);

			const fleet = await db.aircraft.where('companyId').equals(company.id).toArray();
			expect(fleet.length).toBeGreaterThan(0);
			for (const aircraft of fleet) {
				const model = getModel(aircraft.modelId);
				await db.aircraft.update(aircraft.id!, {
					kmSinceMaintenance: model.maintenanceIntervalKm + 500
				});
			}

			await advanceHours(24 * 7);

			const checks = await db.transaction_records
				.where('companyId')
				.equals(company.id)
				.filter((record) => record.category === 'maintenance')
				.count();

			expect(checks).toBeGreaterThan(0);
		});
	});

	describe('WHEN the daily fee falls due', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should move one share to a desk and print the trade', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);

			await runCeoDays(1);

			const trades = await db.share_trades.where('companyId').equals(company.id).toArray();
			expect(await sharesHeldBy(company.id, PLAYER_HOLDER_ID)).toBe(TOTAL_SHARES - 1);
			expect(await registerTotal(company.id)).toBe(TOTAL_SHARES);
			expect(trades).toHaveLength(1);
			expect(trades[0].sellerId).toBe(PLAYER_HOLDER_ID);
			expect(trades[0].buyerId).toMatch(/^b:/);
			expect(trades[0].quantity).toBe(1);
		});

		it('should charge one share a day and mint none of them', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);

			await runCeoDays(10);

			const desks = (await deskHoldings()).reduce((sum, holding) => sum + holding.quantity, 0);
			expect(await sharesHeldBy(company.id, PLAYER_HOLDER_ID)).toBe(TOTAL_SHARES - 10);
			expect(desks).toBe(10);
			expect(await registerTotal(company.id)).toBe(TOTAL_SHARES);
		});

		it('should spread the fees across the desks and never past the cap', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);

			await runCeoDays(12);

			const holdings = await deskHoldings();
			expect(holdings.length).toBeGreaterThan(1);
			for (const holding of holdings) {
				expect(holding.quantity).toBeLessThanOrEqual(CONTROL_THRESHOLD);
			}
		});

		it('should pass over a desk that already holds a big block', async () => {
			const company = await foundAirline();
			const loaded = brokerHolderId((await db.brokers.toArray())[0].id);
			const block = 1_400;

			await listSharesForSale(company.id, PLAYER_HOLDER_ID, block, 1, company.id);
			const listing = (await db.share_listings.where('companyId').equals(company.id).toArray())[0];
			await fillListingAsBroker(listing.id, loaded, block);
			await hireCeo(company.id);

			await runCeoDays(1);

			// The fee goes to the emptiest desk, so the one already sitting on a block is left
			// where it is. A desk can never actually reach the cap while the player still holds
			// a majority — the two together would need more shares than the register has.
			expect(await sharesHeldBy(company.id, loaded)).toBe(block);
			expect((await deskHoldings()).some((holding) => holding.quantity === 1)).toBe(true);
			expect(await registerTotal(company.id)).toBe(TOTAL_SHARES);
		});

		/**
		 * The only test that reaches the fee through the clock rather than by calling the day
		 * function directly, so it is the one that proves the tick actually runs it.
		 */
		it('should charge a share for every day the world closes', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);

			await advanceHours(24 * 3);

			expect(await sharesHeldBy(company.id, PLAYER_HOLDER_ID)).toBe(TOTAL_SHARES - 3);
			expect(await db.share_trades.where('companyId').equals(company.id).count()).toBe(3);
		});

		it('should charge a day only once', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);
			const day = dayIndexOf(gameNow()) + 1;

			await runCeoDay(day);
			await runCeoDay(day);

			expect(await sharesHeldBy(company.id, PLAYER_HOLDER_ID)).toBe(TOTAL_SHARES - 1);
		});

		it('should reach the same holdings in two worlds run the same way', async () => {
			const first = await foundAirline();
			await hireCeo(first.id);
			await runCeoDays(5);
			const firstHoldings = (await deskHoldings())
				.map((holding) => `${holding.holderId}:${holding.quantity}`)
				.sort();

			await freshWorld();
			const second = await foundAirline();
			await hireCeo(second.id);
			await runCeoDays(5);
			const secondHoldings = (await deskHoldings())
				.map((holding) => `${holding.holderId}:${holding.quantity}`)
				.sort();

			expect(secondHoldings).toEqual(firstHoldings);
		});
	});

	describe('WHEN the player stops controlling the airline', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should dismiss the chief executive the day the fee costs control', async () => {
			const company = await foundAirline();
			await leavePlayerHolding(company.id, CONTROL_THRESHOLD + 1);
			await hireCeo(company.id);

			await runCeoDays(2);

			const fresh = await db.companies.get(company.id);
			expect(await sharesHeldBy(company.id, PLAYER_HOLDER_ID)).toBe(CONTROL_THRESHOLD);
			expect(fresh!.ceoHired).toBe(false);
			expect(fresh!.controller).toBe('ai');
			expect(await registerTotal(company.id)).toBe(TOTAL_SHARES);
		});

		it('should dismiss the chief executive when the shares are sold instead', async () => {
			const company = await foundAirline();
			await hireCeo(company.id);
			const desk = brokerHolderId((await db.brokers.toArray())[0].id);
			const sold = TOTAL_SHARES - CONTROL_THRESHOLD;

			await listSharesForSale(company.id, PLAYER_HOLDER_ID, sold, 1, company.id);
			const listing = (await db.share_listings.where('companyId').equals(company.id).toArray())[0];
			await fillListingAsBroker(listing.id, desk, sold);

			const fresh = await db.companies.get(company.id);
			expect(await sharesHeldBy(company.id, PLAYER_HOLDER_ID)).toBe(CONTROL_THRESHOLD);
			expect(fresh!.ceoHired).toBe(false);
			expect(fresh!.controller).toBe('ai');
		});

		it('should stop charging once the chief executive is gone', async () => {
			const company = await foundAirline();
			await leavePlayerHolding(company.id, CONTROL_THRESHOLD + 1);
			await hireCeo(company.id);

			await runCeoDays(6);

			const trades = await db.share_trades.where('companyId').equals(company.id).count();
			expect(trades).toBe(1);
		});
	});

	describe('WHEN an airline was founded before chief executives existed', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should treat a row with no flag as nobody having been hired', async () => {
			const company = await foundAirline();
			// A row as an older save would have written it, with neither field present.
			await db.companies.update(company.id, { ceoHired: undefined, lastCeoDay: undefined });

			await runCeoDays(3);
			await runAiDays(3);

			const fresh = await db.companies.get(company.id);
			expect(await sharesHeldBy(company.id, PLAYER_HOLDER_ID)).toBe(TOTAL_SHARES);
			expect(fresh!.lastAiDay).toBe(company.lastAiDay);
		});
	});
});
