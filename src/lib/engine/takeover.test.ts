import { beforeEach, describe, expect, it } from 'vitest';
// Ahead of anything that reaches for `db`: this is what installs the in-memory IndexedDB.
import { freshWorld, runBidDays } from './testing/world';
import {
	GameError,
	companyValuation,
	createCompany,
	listSharesForSale,
	moveShares,
	openTakeoverBid,
	sharesHeldBy
} from '$db/repo';
import type { ShareholderRow } from '$db/repo';
import {
	CONTROL_THRESHOLD,
	PLAYER_HOLDER_ID,
	TOTAL_SHARES,
	brokerHolderId,
	companyHolderId,
	db
} from '$db/schema';
import type { BrokerTemperament } from './broker';
import { dayIndexOf, gameNow } from './clock';
import { MIN_SHARE_PRICE } from './economy';
import {
	BID_FEE_SHARE,
	BID_LOCKOUT_DAYS,
	BID_WINDOW_DAYS,
	CROSS_HOLDING_RESERVATION,
	DESK_BID_PREMIUM,
	DESPERATE_CROSS_HOLDING_RESERVATION,
	DESPERATE_TREASURY_RESERVATION,
	MIN_BID_PREMIUM,
	TREASURY_RESERVATION,
	bidContextFor,
	judgeRegister,
	minimumBidPrice,
	priceForControl,
	recommendedBidPrice,
	refundFor,
	reservationPriceFor,
	runBidDay,
	type BidContext
} from './takeover';
import { companyDossier } from './market';

const BOOK = 10_000;
const QUOTED = 12_000;

const temperament = (profitTakeMultiplier: number): BrokerTemperament => ({
	assetCeiling: 1.2,
	dailyShareCap: 200,
	engagementChance: 0.6,
	profitTakeMultiplier
});

const context = (overrides: Partial<BidContext> = {}): BidContext => ({
	deskTemperaments: new Map([
		['b:1', temperament(1.25)],
		['b:2', temperament(1.55)]
	]),
	holderCash: new Map([
		['c:7', 40_000_000],
		['c:8', 1_000_000]
	]),
	quotedSharePrice: QUOTED,
	bookValuePerShare: BOOK,
	cashRunwayDays: 90,
	...overrides
});

const holder = (holderId: string, quantity: number, isTreasury = false): ShareholderRow => ({
	holderId,
	name: holderId,
	quantity,
	isViewer: holderId === PLAYER_HOLDER_ID,
	isTreasury,
	controls: quantity > CONTROL_THRESHOLD
});

describe('takeover bids', () => {
	describe('WHEN a holder names the price it would sell at', () => {
		it.each`
			scenario                        | row                              | overrides                     | expected
			${'the bidder itself'}          | ${holder(PLAYER_HOLDER_ID, 500)} | ${{}}                         | ${Number.POSITIVE_INFINITY}
			${'a comfortable board'}        | ${holder('c:1', 1200, true)}     | ${{}}                         | ${BOOK * TREASURY_RESERVATION}
			${'a board running out of cash'} | ${holder('c:1', 1200, true)}    | ${{ cashRunwayDays: 4 }}      | ${BOOK * DESPERATE_TREASURY_RESERVATION}
			${'a cash-rich cross-holder'}   | ${holder('c:7', 300)}            | ${{}}                         | ${BOOK * CROSS_HOLDING_RESERVATION}
			${'a cash-poor cross-holder'}   | ${holder('c:8', 300)}            | ${{}}                         | ${BOOK * DESPERATE_CROSS_HOLDING_RESERVATION}
			${'a desk taking profits low'}  | ${holder('b:1', 400)}            | ${{}}                         | ${BOOK * 1.25}
			${'a desk holding out'}         | ${holder('b:2', 400)}            | ${{}}                         | ${BOOK * 1.55}
		`('should want $expected for $scenario', ({ row, overrides, expected }) => {
			const result = reservationPriceFor(
				row as ShareholderRow,
				PLAYER_HOLDER_ID,
				context(overrides as Partial<BidContext>)
			);

			expect(result.price).toBe(expected);
		});

		it('should never let a desk sell below the market, whatever its own target says', () => {
			const hot = context({ quotedSharePrice: BOOK * 2 });

			const result = reservationPriceFor(holder('b:1', 400), PLAYER_HOLDER_ID, hot);

			expect(result.price).toBe(Math.round(BOOK * 2 * DESK_BID_PREMIUM));
		});

		it('should never quote a reservation under the price floor', () => {
			const insolvent = context({ bookValuePerShare: -5_000, quotedSharePrice: MIN_SHARE_PRICE });

			const board = reservationPriceFor(holder('c:1', 1200, true), PLAYER_HOLDER_ID, insolvent);

			expect(board.price).toBe(MIN_SHARE_PRICE);
		});

		it('should treat a board as desperate only once the runway is genuinely short', () => {
			const boardRow = holder('c:1', 1200, true);

			const noRunwayAtAll = reservationPriceFor(boardRow, PLAYER_HOLDER_ID, context({ cashRunwayDays: null }));
			const plenty = reservationPriceFor(boardRow, PLAYER_HOLDER_ID, context({ cashRunwayDays: 40 }));

			expect(noRunwayAtAll.reason).toBe('treasury');
			expect(plenty.reason).toBe('treasury');
		});
	});

	describe('WHEN the register is put to the offer', () => {
		const register = [
			holder('c:1', 1_200, true),
			holder('b:1', 900),
			holder('b:2', 600),
			holder(PLAYER_HOLDER_ID, 300)
		];

		it('should take only the holders whose price the offer has reached', () => {
			const offer = BOOK * 1.3;

			const judged = judgeRegister(register, PLAYER_HOLDER_ID, offer, TOTAL_SHARES, context());

			expect(judged.filter((row) => row.accepts).map((row) => row.holderId)).toEqual(['b:1']);
		});

		it('should never count the bidder among the sellers', () => {
			const judged = judgeRegister(register, PLAYER_HOLDER_ID, BOOK * 5, TOTAL_SHARES, context());

			const bidder = judged.find((row) => row.holderId === PLAYER_HOLDER_ID);
			expect(bidder?.accepts).toBe(false);
			expect(bidder?.tendering).toBe(0);
		});

		it('should buy out the cheapest holders first when the block runs short', () => {
			const judged = judgeRegister(register, PLAYER_HOLDER_ID, BOOK * 5, 1_000, context());

			const tendering = judged.filter((row) => row.tendering > 0);
			expect(tendering.map((row) => [row.holderId, row.tendering])).toEqual([
				['b:1', 900],
				['b:2', 100]
			]);
		});

		it('should never tender more than the block asked for', () => {
			const judged = judgeRegister(register, PLAYER_HOLDER_ID, BOOK * 5, 1_400, context());

			const total = judged.reduce((sum, row) => sum + row.tendering, 0);
			expect(total).toBe(1_400);
		});

		it('should tender nothing when the block is empty', () => {
			const judged = judgeRegister(register, PLAYER_HOLDER_ID, BOOK * 5, 0, context());

			expect(judged.every((row) => row.tendering === 0)).toBe(true);
		});

		it('should resolve the same way whatever order the register arrives in', () => {
			const reversed = [...register].reverse();

			const forwards = judgeRegister(register, PLAYER_HOLDER_ID, BOOK * 5, 1_000, context());
			const backwards = judgeRegister(reversed, PLAYER_HOLDER_ID, BOOK * 5, 1_000, context());

			const asPairs = (rows: typeof forwards) =>
				rows.map((row) => `${row.holderId}:${row.tendering}`).sort();
			expect(asPairs(forwards)).toEqual(asPairs(backwards));
		});
	});

	describe('WHEN quoting the price a controlling stake would take', () => {
		it('should name a real price for an airline with nothing on the market', () => {
			const register = [holder('c:1', 3_000, true)];

			const result = priceForControl(register, PLAYER_HOLDER_ID, 0, context());

			expect(result).toBe(BOOK * TREASURY_RESERVATION);
		});

		it('should be reachable more cheaply once the board is short of cash', () => {
			const register = [holder('c:1', 3_000, true)];

			const comfortable = priceForControl(register, PLAYER_HOLDER_ID, 0, context());
			const desperate = priceForControl(
				register,
				PLAYER_HOLDER_ID,
				0,
				context({ cashRunwayDays: 3 })
			);

			expect(desperate).toBeLessThan(comfortable!);
		});

		it('should stop at the cheapest holders when they alone carry a majority', () => {
			const register = [holder('c:1', 1_400, true), holder('b:1', 1_600)];

			const result = priceForControl(register, PLAYER_HOLDER_ID, 0, context());

			expect(result).toBe(BOOK * 1.25);
		});

		it('should count the shares the bidder already holds', () => {
			const register = [holder(PLAYER_HOLDER_ID, 1_400), holder('b:2', 1_600)];

			const result = priceForControl(register, PLAYER_HOLDER_ID, 1_400, context());

			expect(result).toBe(BOOK * 1.55);
		});

		it('should always name a price when the whole register is in front of it', () => {
			const register = [holder('c:1', 1_500, true), holder('b:2', 1_500)];

			const result = priceForControl(register, PLAYER_HOLDER_ID, 0, context());

			expect(result).not.toBeNull();
		});

		it('should return nothing when the shares outside the bidder could not carry a majority', () => {
			const partial = [holder(PLAYER_HOLDER_ID, 100), holder('b:1', 200)];

			const result = priceForControl(partial, PLAYER_HOLDER_ID, 100, context());

			expect(result).toBeNull();
		});

		it('should return nothing when no holder on the register is one the rules can read', () => {
			const unreadable = [holder(PLAYER_HOLDER_ID, 100), holder('x:9', 2_900)];

			const result = priceForControl(unreadable, PLAYER_HOLDER_ID, 100, context());

			expect(result).toBeNull();
		});

		it('should need a strict majority rather than half', () => {
			const register = [holder(PLAYER_HOLDER_ID, 1_499), holder('b:1', 1), holder('b:2', 1_500)];

			const justOverHalf = priceForControl(register, PLAYER_HOLDER_ID, 1_499, context());

			expect(justOverHalf).toBe(BOOK * 1.55);
		});
	});

	describe('WHEN the least a bid may offer is worked out', () => {
		it('should ask for a premium over the screen price', () => {
			const result = minimumBidPrice(QUOTED);

			expect(result).toBe(Math.round(QUOTED * MIN_BID_PREMIUM));
		});

		it('should never fall under the price floor', () => {
			const result = minimumBidPrice(1);

			expect(result).toBe(MIN_SHARE_PRICE);
		});
	});

	describe('WHEN the escrow is settled up', () => {
		it.each`
			escrow      | spent      | expected
			${100_000}  | ${100_000} | ${0}
			${100_000}  | ${0}       | ${98_000}
			${100_000}  | ${40_000}  | ${58_800}
		`(
			'should return $expected of a $escrow escrow that spent $spent',
			({ escrow, spent, expected }) => {
				const result = refundFor(escrow as number, spent as number);

				expect(result).toBe(expected);
			}
		);

		it('should keep the fee proportional to what went unspent', () => {
			const unspent = 100_000 - 40_000;

			const result = refundFor(100_000, 40_000);

			expect(unspent - result).toBe(unspent * BID_FEE_SHARE);
		});
	});
});

/* ------------------------------------------------------------ against a real world */

const aiCompanyId = async (): Promise<number> =>
	(await db.companies.where('controller').equals('ai').toArray())[0].id;

/**
 * The airline the bid is banked through. A fresh world has none — the player founds theirs —
 * so every scenario here needs one, and it is deliberately not the target.
 */
const playerCompanyId = async (): Promise<number> => {
	const existing = await db.companies.where('controller').equals('player').toArray();
	if (existing.length > 0) return existing[0].id;

	const founded = await createCompany({ name: 'Holding Air', icao: 'HLD', homeIata: 'BCN' });
	return founded.id;
};

const fund = async (companyId: number, cash: number): Promise<void> => {
	await db.companies.update(companyId, { cash });
};

const registerTotal = async (companyId: number): Promise<number> =>
	(await db.shareholdings.where('companyId').equals(companyId).toArray()).reduce(
		(sum, holding) => sum + holding.quantity,
		0
	);

const closesDay = (): number => dayIndexOf(gameNow()) + BID_WINDOW_DAYS;

/**
 * Puts an offer on the table. Priced as the screen would default it — the control price plus
 * the recommended headroom — because a bid pitched at the bare control price is judged days
 * later against a book value that has moved, which is a coin flip rather than a scenario.
 */
const bidForControl = async (
	targetId: number,
	sharesSought = CONTROL_THRESHOLD + 1,
	pricing: 'recommended' | 'bare' = 'recommended'
): Promise<{ bidId: number; pricePerShare: number; bidderCompanyId: number }> => {
	const dossier = (await companyDossier(targetId))!;
	const context = await bidContextFor(dossier);
	const held = await sharesHeldBy(targetId, PLAYER_HOLDER_ID);
	const control = priceForControl(dossier.register, PLAYER_HOLDER_ID, held, context)!;
	const price =
		pricing === 'bare' ? control : recommendedBidPrice(control, dossier.valuation.sharePrice);
	const bidderCompanyId = await playerCompanyId();

	await fund(bidderCompanyId, price * sharesSought * 4);
	const bid = await openTakeoverBid({
		targetCompanyId: targetId,
		bidderHolderId: PLAYER_HOLDER_ID,
		bidderCompanyId,
		pricePerShare: price,
		sharesSought,
		closesDay: closesDay()
	});

	return { bidId: bid.id, pricePerShare: price, bidderCompanyId };
};

describe('takeover bids against a live world', () => {
	beforeEach(async () => {
		await freshWorld();
	});

	describe('WHEN an offer is launched', () => {
		it('should take the escrow out of the wallet at once', async () => {
			const targetId = await aiCompanyId();
			const bidderCompanyId = await playerCompanyId();
			await fund(bidderCompanyId, 500_000_000);
			const before = (await db.companies.get(bidderCompanyId))!.cash;

			await openTakeoverBid({
				targetCompanyId: targetId,
				bidderHolderId: PLAYER_HOLDER_ID,
				bidderCompanyId,
				pricePerShare: 10_000,
				sharesSought: 1_501,
				closesDay: closesDay()
			});

			const after = (await db.companies.get(bidderCompanyId))!.cash;
			expect(before - after).toBe(10_000 * 1_501);
		});

		it('should record the offer against the airline it is aimed at', async () => {
			const targetId = await aiCompanyId();

			await bidForControl(targetId);

			const bids = await db.takeover_bids.toArray();
			expect(bids).toHaveLength(1);
			expect(bids[0].targetCompanyId).toBe(targetId);
			expect(bids[0].status).toBe('open');
		});

		it('should leave the wallet and the bid table untouched when the escrow is unaffordable', async () => {
			const targetId = await aiCompanyId();
			const bidderCompanyId = await playerCompanyId();
			await fund(bidderCompanyId, 1_000);

			await expect(
				openTakeoverBid({
					targetCompanyId: targetId,
					bidderHolderId: PLAYER_HOLDER_ID,
					bidderCompanyId,
					pricePerShare: 10_000,
					sharesSought: 1_501,
					closesDay: closesDay()
				})
			).rejects.toThrow(GameError);

			expect((await db.companies.get(bidderCompanyId))!.cash).toBe(1_000);
			expect(await db.takeover_bids.count()).toBe(0);
		});

		it('should refuse a second offer while one is still open', async () => {
			const targetId = await aiCompanyId();
			await bidForControl(targetId);

			await expect(bidForControl(targetId)).rejects.toThrow('already an offer open');
		});

		it('should refuse an offer for an airline the bidder already controls', async () => {
			const ownId = await playerCompanyId();
			const bidderCompanyId = ownId;
			await fund(bidderCompanyId, 500_000_000);

			await expect(
				openTakeoverBid({
					targetCompanyId: ownId,
					bidderHolderId: PLAYER_HOLDER_ID,
					bidderCompanyId,
					pricePerShare: 10_000,
					sharesSought: 100,
					closesDay: closesDay()
				})
			).rejects.toThrow('already control');
		});

		it('should refuse an offer for nothing at all', async () => {
			const targetId = await aiCompanyId();
			const bidderCompanyId = await playerCompanyId();

			await expect(
				openTakeoverBid({
					targetCompanyId: targetId,
					bidderHolderId: PLAYER_HOLDER_ID,
					bidderCompanyId,
					pricePerShare: 10_000,
					sharesSought: 0,
					closesDay: closesDay()
				})
			).rejects.toThrow('Nothing to bid for');
		});
	});

	describe('WHEN an offer closes', () => {
		it('should hand over control of an airline with nothing on the market', async () => {
			const targetId = await aiCompanyId();
			expect((await companyDossier(targetId))!.sharesForSale).toBe(0);

			await bidForControl(targetId);
			await runBidDays(BID_WINDOW_DAYS);

			expect(await sharesHeldBy(targetId, PLAYER_HOLDER_ID)).toBeGreaterThan(CONTROL_THRESHOLD);
			expect((await db.companies.get(targetId))!.controller).toBe('player');
		});

		it('should keep the register at exactly three thousand shares', async () => {
			const targetId = await aiCompanyId();

			await bidForControl(targetId);
			await runBidDays(BID_WINDOW_DAYS);

			expect(await registerTotal(targetId)).toBe(TOTAL_SHARES);
		});

		it('should never leave a holding negative', async () => {
			const targetId = await aiCompanyId();

			await bidForControl(targetId);
			await runBidDays(BID_WINDOW_DAYS);

			const holdings = await db.shareholdings.where('companyId').equals(targetId).toArray();
			expect(holdings.every((holding) => holding.quantity > 0)).toBe(true);
		});

		it('should pay the board for the shares it gave up', async () => {
			const targetId = await aiCompanyId();
			await fund(targetId, 5_000_000);
			const before = (await db.companies.get(targetId))!.cash;

			await bidForControl(targetId);
			await runBidDays(BID_WINDOW_DAYS);

			expect((await db.companies.get(targetId))!.cash).toBeGreaterThan(before);
		});

		it('should write a trade for every holder that tendered', async () => {
			const targetId = await aiCompanyId();

			await bidForControl(targetId);
			await runBidDays(BID_WINDOW_DAYS);

			const trades = await db.share_trades.where('companyId').equals(targetId).toArray();
			expect(trades.length).toBeGreaterThan(0);
			expect(trades.every((trade) => trade.buyerId === PLAYER_HOLDER_ID)).toBe(true);
		});

		it('should stamp the offer as succeeded and stop reporting it as open', async () => {
			const targetId = await aiCompanyId();
			const { bidId } = await bidForControl(targetId);

			await runBidDays(BID_WINDOW_DAYS);

			const bid = (await db.takeover_bids.get(bidId))!;
			expect(bid.status).toBe('succeeded');
			expect(bid.resolvedAt).not.toBeNull();
			expect(bid.sharesTendered).toBeGreaterThan(CONTROL_THRESHOLD);
		});

		it('should leave a tendering holder no ask it can no longer honour', async () => {
			const targetId = await aiCompanyId();
			const deskHolder = brokerHolderId((await db.brokers.toArray())[0].id);
			const boardHolder = companyHolderId(targetId);

			// Hand a desk a block, then have it promise most of that block to the order book.
			await moveShares(targetId, boardHolder, deskHolder, 300);
			await listSharesForSale(targetId, deskHolder, 200, 9_999_999);

			await bidForControl(targetId, TOTAL_SHARES);
			await runBidDays(BID_WINDOW_DAYS);

			const held = await sharesHeldBy(targetId, deskHolder);
			const listed = (await db.share_listings.where('companyId').equals(targetId).toArray())
				.filter((listing) => listing.sellerId === deskHolder)
				.reduce((sum, listing) => sum + listing.quantity, 0);

			expect(listed).toBeLessThanOrEqual(held);
		});

		it('should refund the unspent escrow less the fee when nobody tenders', async () => {
			const targetId = await aiCompanyId();
			const bidderCompanyId = await playerCompanyId();
			await fund(bidderCompanyId, 500_000_000);
			const before = (await db.companies.get(bidderCompanyId))!.cash;

			// A price nobody's reservation could ever reach downward: the floor plus a penny.
			const bid = await openTakeoverBid({
				targetCompanyId: targetId,
				bidderHolderId: PLAYER_HOLDER_ID,
				bidderCompanyId,
				pricePerShare: MIN_SHARE_PRICE,
				sharesSought: 1_501,
				closesDay: closesDay()
			});
			await runBidDays(BID_WINDOW_DAYS);

			const escrow = MIN_SHARE_PRICE * 1_501;
			const after = (await db.companies.get(bidderCompanyId))!.cash;
			expect((await db.takeover_bids.get(bid.id))!.status).toBe('failed');
			expect(before - after).toBe(escrow - refundFor(escrow, 0));
		});

		it('should bar a fresh offer after seeing one off, and allow it again later', async () => {
			const targetId = await aiCompanyId();
			const bidderCompanyId = await playerCompanyId();
			await fund(bidderCompanyId, 500_000_000);

			await openTakeoverBid({
				targetCompanyId: targetId,
				bidderHolderId: PLAYER_HOLDER_ID,
				bidderCompanyId,
				pricePerShare: MIN_SHARE_PRICE,
				sharesSought: 1_501,
				closesDay: closesDay()
			});
			await runBidDays(BID_WINDOW_DAYS);

			await expect(bidForControl(targetId)).rejects.toThrow('barred a fresh offer');

			const lockout = (await db.companies.get(targetId))!.bidLockoutUntilDay!;
			expect(lockout).toBe(dayIndexOf(gameNow()) + BID_LOCKOUT_DAYS);
		});

		it('should not bar a fresh offer after a partial win', async () => {
			const targetId = await aiCompanyId();

			await bidForControl(targetId, 200);
			await runBidDays(BID_WINDOW_DAYS);

			expect((await db.companies.get(targetId))!.bidLockoutUntilDay).toBeUndefined();
			await expect(bidForControl(targetId)).resolves.toBeDefined();
		});

		it('should judge the offer against the register as it closes, not as it was launched', async () => {
			const targetId = await aiCompanyId();
			await fund(targetId, 80_000_000);

			// Pitched at the bare control price, with no headroom for the days in between: the
			// board's book value moves while the offer is open, and the offer does not follow it.
			const { bidId, pricePerShare } = await bidForControl(targetId, CONTROL_THRESHOLD + 1, 'bare');
			await db.companies.update(targetId, { cash: 400_000_000 });
			await runBidDays(BID_WINDOW_DAYS);

			const dossier = (await companyDossier(targetId))!;
			expect(dossier.bookValuePerShare * TREASURY_RESERVATION).toBeGreaterThan(pricePerShare);
			expect((await db.takeover_bids.get(bidId))!.status).toBe('failed');
		});

		it('should keep a partial win without handing over control', async () => {
			const targetId = await aiCompanyId();
			const { bidId } = await bidForControl(targetId, 200);

			await runBidDays(BID_WINDOW_DAYS);

			expect((await db.takeover_bids.get(bidId))!.status).toBe('partial');
			expect(await sharesHeldBy(targetId, PLAYER_HOLDER_ID)).toBe(200);
			expect((await db.companies.get(targetId))!.controller).toBe('ai');
		});

		it('should resolve an offer whose closing day was jumped over', async () => {
			const targetId = await aiCompanyId();
			const { bidId } = await bidForControl(targetId);

			// One close, far past the window: the shape a thirty-day catch-up produces.
			const { runBidDay } = await import('./takeover');
			await runBidDay(dayIndexOf(gameNow()) + BID_WINDOW_DAYS + 20);

			expect((await db.takeover_bids.get(bidId))!.status).not.toBe('open');
		});

		it('should take one turn per closed day and no more', async () => {
			const targetId = await aiCompanyId();
			const { bidId } = await bidForControl(targetId);
			const day = dayIndexOf(gameNow()) + BID_WINDOW_DAYS;

			await runBidDay(day);
			const settled = await db.shareholdings.where('companyId').equals(targetId).toArray();
			await runBidDay(day);

			expect((await db.takeover_bids.get(bidId))!.sharesTendered).toBeGreaterThan(0);
			expect(await db.shareholdings.where('companyId').equals(targetId).toArray()).toEqual(
				settled
			);
		});
	});

	describe('WHEN the board defends itself', () => {
		it('should re-rate the shares upward the night the offer becomes public', async () => {
			const targetId = await aiCompanyId();
			await fund(targetId, 80_000_000);
			const before = (await db.companies.get(targetId))!.marketMultiplier;

			await bidForControl(targetId);
			await runBidDays(1);

			const after = (await db.companies.get(targetId))!.marketMultiplier;
			expect(after).toBeGreaterThan(before);
			expect(after).toBeLessThanOrEqual(1.8);
		});

		it('should say what it did in words the screens can print', async () => {
			const targetId = await aiCompanyId();
			await fund(targetId, 80_000_000);
			const { bidId } = await bidForControl(targetId);

			await runBidDays(1);

			expect((await db.takeover_bids.get(bidId))!.defence).toMatch(/re-rated/);
		});

		it('should spend a comfortable board’s cash buying its own float back', async () => {
			const targetId = await aiCompanyId();
			await fund(targetId, 400_000_000);
			const deskHolder = brokerHolderId((await db.brokers.toArray())[0].id);
			await moveShares(targetId, companyHolderId(targetId), deskHolder, 300);
			const { bookValue } = await companyValuation(targetId);
			await listSharesForSale(targetId, deskHolder, 300, Math.round(bookValue));

			const treasuryBefore = await sharesHeldBy(targetId, companyHolderId(targetId));
			await bidForControl(targetId);
			// Day one is the rumour; the buy-back comes the night after.
			await runBidDays(2);

			expect(await sharesHeldBy(targetId, companyHolderId(targetId))).toBeGreaterThan(
				treasuryBefore
			);
		});

		it('should leave a board with no runway unable to lift a finger', async () => {
			const targetId = await aiCompanyId();
			await fund(targetId, 1);
			const { bidId } = await bidForControl(targetId);

			await runBidDays(1);

			expect((await db.takeover_bids.get(bidId))!.defence).toBeNull();
		});

		it('should hand a starved airline over, since it can neither fight nor hold out', async () => {
			const targetId = await aiCompanyId();
			await fund(targetId, 1);

			await bidForControl(targetId);
			await runBidDays(BID_WINDOW_DAYS);

			expect((await db.companies.get(targetId))!.controller).toBe('player');
		});

		it('should never raise cash by undercutting the price it is refusing', async () => {
			const targetId = await aiCompanyId();
			await fund(targetId, 6_000_000);
			const treasuryBefore = await sharesHeldBy(targetId, companyHolderId(targetId));

			await bidForControl(targetId);
			await runBidDays(BID_WINDOW_DAYS - 1);

			// A board short of cash has nothing it can do that would not raise its own asking
			// price, so its float stays where it is rather than going cheaply to a desk.
			expect(await sharesHeldBy(targetId, companyHolderId(targetId))).toBe(treasuryBefore);
		});
	});

	describe('WHEN the days close on their own', () => {
		it('should resolve an offer through the ordinary day close and report it', async () => {
			const targetId = await aiCompanyId();
			await bidForControl(targetId);

			// The real path the browser takes, rather than calling the pass directly.
			const { catchUp } = await import('./tick');
			const { setClockOffset, getClockOffset } = await import('./clock');
			setClockOffset(getClockOffset() + BID_WINDOW_DAYS * 24 * 3_600_000);
			const summary = await catchUp();

			expect(summary.bidOutcomes).toHaveLength(1);
			expect(summary.bidOutcomes[0].targetIcao).toBe(
				(await db.companies.get(targetId))!.icao
			);
			expect(summary.bidOutcomes[0].sharesWon).toBeGreaterThan(0);
			expect(await db.takeover_bids.where('status').equals('open').count()).toBe(0);
		});

		it('should report nothing about offers on a day close with none open', async () => {
			const { catchUp } = await import('./tick');
			const { setClockOffset, getClockOffset } = await import('./clock');
			setClockOffset(getClockOffset() + 2 * 24 * 3_600_000);

			const summary = await catchUp();

			expect(summary.bidOutcomes).toEqual([]);
		});
	});

	describe('WHEN two worlds are bid into the same way', () => {
		const bidAndSnapshot = async (): Promise<string[]> => {
			const targetId = await aiCompanyId();
			await fund(targetId, 60_000_000);
			await bidForControl(targetId);
			await runBidDays(BID_WINDOW_DAYS);

			const holdings = await db.shareholdings.where('companyId').equals(targetId).toArray();
			const company = (await db.companies.get(targetId))!;

			return [
				...holdings.map((holding) => `${holding.holderId}:${holding.quantity}`).sort(),
				`cash:${company.cash}`,
				`multiplier:${company.marketMultiplier}`,
				`controller:${company.controller}`
			];
		};

		it('should reach the same register, cash and sentiment in both', async () => {
			const first = await bidAndSnapshot();

			await freshWorld();
			const second = await bidAndSnapshot();

			expect(second).toEqual(first);
		});
	});
});
