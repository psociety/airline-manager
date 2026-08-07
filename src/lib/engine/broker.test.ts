import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceHours, freshWorld, runBrokerDays } from './testing/world';
import {
	CONTROL_THRESHOLD,
	PLAYER_HOLDER_ID,
	TOTAL_SHARES,
	brokerHolderId,
	companyHolderId,
	db,
	type Broker
} from '$db/schema';
import { companyValuation, fillListingAsBroker, listSharesForSale, shareRegister } from '$db/repo';
import { ceilingFor, isWreck, temperamentOf } from './broker';
import type { CompanyDossier } from './market';

const desk = async (index = 0): Promise<Broker> => (await db.brokers.toArray())[index];

const dossier = (overrides: Partial<CompanyDossier> = {}): CompanyDossier =>
	({
		company: { cash: 5_000_000 },
		assets: { total: 20_000_000 },
		pnl: { dailyOperatingResult: 50_000 },
		cashRunwayDays: 90,
		pendingIncidentExposure: 0,
		annualisedLeaseExposure: 0,
		...overrides
	}) as CompanyDossier;

const deskHoldings = async () =>
	(await db.shareholdings.toArray()).filter((holding) => holding.holderId.startsWith('b:'));

/**
 * Puts a carrier's own float on the market at a price the desks will take, without waiting the
 * fortnight it takes an airline to run its cash down far enough to do it unprompted.
 */
const floatOwnShares = async (companyId: number, quantity: number): Promise<number> => {
	const { bookValue } = await companyValuation(companyId);
	await db.companies.update(companyId, { cash: 1_000_000 });
	await listSharesForSale(
		companyId,
		companyHolderId(companyId),
		quantity,
		Math.round(bookValue * 0.8)
	);

	const listings = await db.share_listings.where('companyId').equals(companyId).toArray();
	return listings[listings.length - 1].id;
};

const anyAiCompanyId = async (): Promise<number> =>
	(await db.companies.where('controller').equals('ai').toArray())[0].id;

/** Runs a float past the desks and reports what they ended up holding, as comparable text. */
const tradedHoldings = async (): Promise<string[]> => {
	const companyId = await anyAiCompanyId();
	await floatOwnShares(companyId, 400);
	await runBrokerDays(3);

	return (await deskHoldings())
		.map((holding) => `${holding.companyId}:${holding.holderId}:${holding.quantity}`)
		.sort();
};

describe('broker desks', () => {
	// No world at all: these read a seeded desk's character, or nothing but pure functions.
	describe('WHEN a desk is given its character', () => {
		beforeAll(async () => {
			await freshWorld();
		});

		it('should keep every desk inside the sane end of the price range', async () => {
			const brokers = await db.brokers.toArray();

			const ceilings = brokers.map((broker) => temperamentOf(broker).assetCeiling);

			expect(Math.min(...ceilings)).toBeGreaterThanOrEqual(1.15);
			expect(Math.max(...ceilings)).toBeLessThanOrEqual(1.4);
		});

		it('should give the desks different characters', async () => {
			const brokers = await db.brokers.toArray();

			const distinct = new Set(brokers.map((broker) => temperamentOf(broker).dailyShareCap));

			expect(brokers).toHaveLength(4);
			expect(distinct.size).toBeGreaterThan(1);
		});

		it('should hold a desk to the same character across the days it trades', async () => {
			const before = temperamentOf(await desk());

			await runBrokerDays(3);

			expect(temperamentOf(await desk())).toEqual(before);
		});

		it('should cap the daily appetite well under a controlling stake', async () => {
			const brokers = await db.brokers.toArray();

			const caps = brokers.map((broker) => temperamentOf(broker).dailyShareCap);

			expect(Math.max(...caps)).toBeLessThan(CONTROL_THRESHOLD);
		});
	});

	describe('WHEN judging whether the assets are impaired', () => {
		it.each`
			scenario                   | overrides                                                            | expected
			${'a sound airline'}       | ${{}}                                                                | ${false}
			${'claims over half'}      | ${{ pendingIncidentExposure: 11_000_000 }}                           | ${true}
			${'claims under half'}     | ${{ pendingIncidentExposure: 9_000_000 }}                            | ${false}
			${'leases over twice'}     | ${{ annualisedLeaseExposure: 41_000_000 }}                           | ${true}
			${'leases merely heavy'}   | ${{ annualisedLeaseExposure: 25_000_000 }}                           | ${false}
			${'out of cash but flying'} | ${{ cashRunwayDays: 4, pnl: { dailyOperatingResult: -9_000 } }}      | ${false}
		`('should say $expected for $scenario', ({ overrides, expected }) => {
			const result = isWreck(dossier(overrides as Partial<CompanyDossier>));

			expect(result).toBe(expected);
		});

		it('should not write off an airline merely for being short of cash', () => {
			const desperate = dossier({
				cashRunwayDays: 2,
				company: { cash: 100 } as CompanyDossier['company'],
				pnl: { dailyOperatingResult: -80_000 } as CompanyDossier['pnl']
			});

			expect(isWreck(desperate)).toBe(false);
		});
	});

	describe('WHEN pricing what it will pay', () => {
		const temperament = {
			assetCeiling: 1.3,
			dailyShareCap: 200,
			engagementChance: 1,
			profitTakeMultiplier: 1.3
		};

		it('should pay its full ceiling for a sound airline', () => {
			const result = ceilingFor(dossier(), temperament);

			expect(result).toBeCloseTo(1.3, 5);
		});

		it('should want it cheaper when the airline is losing money', () => {
			const result = ceilingFor(
				dossier({ pnl: { dailyOperatingResult: -40_000 } as CompanyDossier['pnl'] }),
				temperament
			);

			expect(result).toBeLessThan(1.3);
		});

		it('should want it cheaper again when the cash is nearly gone', () => {
			const bleeding = dossier({
				pnl: { dailyOperatingResult: -40_000 } as CompanyDossier['pnl']
			});
			const bleedingAndBroke = dossier({
				pnl: { dailyOperatingResult: -40_000 } as CompanyDossier['pnl'],
				cashRunwayDays: 5
			});

			expect(ceilingFor(bleedingAndBroke, temperament)).toBeLessThan(
				ceilingFor(bleeding, temperament)
			);
		});

		it('should never demand so little that no price could tempt it', () => {
			const ruined = dossier({
				pnl: { dailyOperatingResult: -900_000 } as CompanyDossier['pnl'],
				cashRunwayDays: 0,
				pendingIncidentExposure: 9_000_000,
				annualisedLeaseExposure: 25_000_000
			});

			expect(ceilingFor(ruined, temperament)).toBeGreaterThanOrEqual(0.7);
		});
	});


	/**
	 * One world, aged once, shared by the assertions below. Every test in this block only
	 * READS what the desks did — anything that writes belongs in a sibling block, or it will
	 * break its neighbours in ways that are hard to localise.
	 *
	 * This is also the suite's only end-to-end proof of the chain: the clock advances, the
	 * carriers float shares inside `runAiDay`, and the desks buy them inside `runBrokerDay`.
	 * Do not replace it with direct `fillListingAsBroker` calls — an earlier version of the
	 * buy screens rejected every seller in the market, and this is the shape of test that
	 * caught it.
	 */
	describe('WHEN the desks have been trading for weeks', () => {
		beforeAll(async () => {
			await freshWorld();
			await advanceHours(24 * 21);
		});

		it('should buy into airlines that float their shares', async () => {
			const holdings = await deskHoldings();

			expect(holdings.length).toBeGreaterThan(0);
			expect(holdings.reduce((sum, holding) => sum + holding.quantity, 0)).toBeGreaterThan(0);
		});

		it('should hand the selling airline real cash for its float', async () => {
			const sales = await db.transaction_records.where('category').equals('share_sale').toArray();

			expect(sales.length).toBeGreaterThan(0);
			expect(sales.every((record) => record.amount > 0)).toBe(true);
		});

		it('should leave shares on the market rather than clearing it out', async () => {
			expect(await db.share_listings.count()).toBeGreaterThan(0);
		});

		it('should never take a stake that could control an airline', async () => {
			// Any `b:` holding counts, however it got there — a chief executive's fee lands in a
			// desk too, and is held to the same cap.
			for (const holding of await deskHoldings()) {
				expect(holding.quantity).toBeLessThanOrEqual(CONTROL_THRESHOLD);
			}
		});

		it('should leave every airline still run by its own people', async () => {
			const companies = await db.companies.toArray();
			const held = new Set((await deskHoldings()).map((holding) => holding.companyId));
			const carriers = companies.filter((company) => held.has(company.id));

			// An airline whose owner hired a chief executive is a legitimate exception to this,
			// so the precondition is asserted rather than assumed: nobody has one in this world.
			expect(companies.some((company) => company.ceoHired ?? false)).toBe(false);
			expect(carriers.length).toBeGreaterThan(0);
			expect(carriers.every((company) => company.controller === 'ai')).toBe(true);
		});

		it('should keep every register at exactly three thousand shares', async () => {
			for (const company of await db.companies.toArray()) {
				const holdings = await db.shareholdings.where('companyId').equals(company.id).toArray();
				const total = holdings.reduce((sum, holding) => sum + holding.quantity, 0);

				expect(total).toBe(TOTAL_SHARES);
			}
		});

		it('should never trade with itself', async () => {
			const trades = await db.share_trades.toArray();

			expect(trades.length).toBeGreaterThan(0);
			expect(trades.every((trade) => trade.buyerId !== trade.sellerId)).toBe(true);
		});

		it('should name the desk on the register rather than its holder id', async () => {
			const holding = (await deskHoldings())[0];
			const register = await shareRegister(holding.companyId, PLAYER_HOLDER_ID);
			const entry = register.find((row) => row.holderId === holding.holderId);

			expect(entry?.name).not.toMatch(/^b:/);
			expect(entry?.name).toMatch(/Capital|Holdings|Partners|Fund/);
		});

		it('should take one turn per closed day and no more', async () => {
			const { catchUp } = await import('./tick');
			const before = await db.share_trades.count();

			await catchUp();
			await catchUp();

			expect(await db.share_trades.count()).toBe(before);
		});
	});

	// A fresh world each, because every test here writes to it.
	describe('WHEN a float is put in front of the desks', () => {
		beforeEach(async () => {
			await freshWorld();
		});

		it('should advance the turn marker once per day', async () => {
			const before = (await db.brokers.toArray()).map((broker) => broker.lastBrokerDay);

			await runBrokerDays(3);

			const after = await db.brokers.toArray();
			for (const [index, broker] of after.entries()) {
				expect(broker.lastBrokerDay).toBeGreaterThan(before[index]);
			}
		});

		it('should buy an ask priced under what it will pay', async () => {
			const companyId = await anyAiCompanyId();
			await floatOwnShares(companyId, 300);

			await runBrokerDays(1);

			expect((await deskHoldings()).length).toBeGreaterThan(0);
		});

		it('should credit the carrier for exactly what the desks took', async () => {
			const companyId = await anyAiCompanyId();
			await floatOwnShares(companyId, 300);
			const cashBefore = (await db.companies.get(companyId))!.cash;

			await runBrokerDays(1);

			const taken = (await deskHoldings())
				.filter((holding) => holding.companyId === companyId)
				.reduce((sum, holding) => sum + holding.quantity, 0);
			const sales = await db.transaction_records.where('category').equals('share_sale').toArray();
			const raised = sales.reduce((sum, record) => sum + record.amount, 0);

			expect(taken).toBeGreaterThan(0);
			expect((await db.companies.get(companyId))!.cash).toBe(cashBefore + raised);
		});

		it('should leave an ask above its ceiling untouched', async () => {
			const companyId = await anyAiCompanyId();
			const { bookValue } = await companyValuation(companyId);
			await db.companies.update(companyId, { cash: 1_000_000 });
			await listSharesForSale(
				companyId,
				companyHolderId(companyId),
				300,
				Math.round(bookValue * 3)
			);

			await runBrokerDays(2);

			expect(await deskHoldings()).toEqual([]);
		});

		// A chief executive's fee is refused at this same cap, by the same arithmetic — see
		// `deskWithRoom` in `ceo.ts`. Do not reuse this fixture to test that path.
		it('should stop bidding once it holds half an airline', async () => {
			const companyId = await anyAiCompanyId();
			const holderId = brokerHolderId((await desk()).id);
			const listingId = await floatOwnShares(companyId, CONTROL_THRESHOLD);
			await fillListingAsBroker(listingId, holderId, CONTROL_THRESHOLD);
			await floatOwnShares(companyId, 200);

			await runBrokerDays(2);

			const held = (await deskHoldings()).find((holding) => holding.holderId === holderId);
			expect(held!.quantity).toBe(CONTROL_THRESHOLD);
		});

		it('should reach the same holdings in two worlds run the same way', async () => {
			const first = await tradedHoldings();

			await freshWorld();

			expect(await tradedHoldings()).toEqual(first);
		});
	});
});
