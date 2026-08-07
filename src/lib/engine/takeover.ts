import {
	bidsDueBy,
	buyBackOwnFloat,
	closeTakeoverBid,
	recordBidDefence,
	setBidLockout,
	settleBidTender,
	sharesHeldBy,
	withdrawTakeoverBid,
	type ShareholderRow
} from '$db/repo';
import {
	CONTROL_THRESHOLD,
	TOTAL_SHARES,
	db,
	holderBrokerId,
	holderCompanyId,
	type BidStatus,
	type TakeoverBid
} from '$db/schema';
import { CASH_FLOOR } from './ai';
import { temperamentOf, type BrokerTemperament } from './broker';
import { dayIndexOf, gameNow } from './clock';
import { MARKET_MULTIPLIER_MAX, MARKET_MULTIPLIER_MIN, MIN_SHARE_PRICE } from './economy';
import { companyDossier, sharesForControl, type CompanyDossier } from './market';
import { seededRng, type Rng } from './rng';

/* --------------------------------------------------------------- the tuning knobs */

/** Day closes a bid stays open, so the board has time to do something about it. */
export const BID_WINDOW_DAYS = 3;

/**
 * The least a bid may offer over the quoted price. A bid at the screen price is not a
 * takeover attempt — anyone willing to sell there has already listed — so requiring a
 * premium is what gives the word its meaning.
 */
export const MIN_BID_PREMIUM = 1.05;

/** Advisers' fee, retained from the unspent escrow. Failure should cost something. */
export const BID_FEE_SHARE = 0.02;

/** Days a beaten board may refuse to entertain another offer. */
export const BID_LOCKOUT_DAYS = 14;

/** Cash runway under which a board stops holding out and takes what it is offered. */
export const DESPERATE_RUNWAY_DAYS = 10;

/**
 * What a comfortable board wants for its own float, as a multiple of book. Deliberately
 * above the top of the sentiment band (`MARKET_MULTIPLIER_MAX`), so a takeover always looks
 * expensive measured against the screen price — that is the premium a control block costs.
 * It is not a wall: a desperate board (below) asks a fraction of it, which is what makes
 * starving a rival and then bidding a real strategy rather than a hope.
 */
export const TREASURY_RESERVATION = 1.9;
export const DESPERATE_TREASURY_RESERVATION = 1.15;

/** What one airline wants for a stake in another, and what it takes when short of cash. */
export const CROSS_HOLDING_RESERVATION = 1.35;
export const DESPERATE_CROSS_HOLDING_RESERVATION = 1.1;

/**
 * A desk never parts with a position below the market, whatever its own book-based target
 * says. This floor is what gives the board's rumour-spike defence its bite: as the stock
 * trades up towards the offer, the offer becomes inadequate.
 */
export const DESK_BID_PREMIUM = 1.02;

/* ---------------------------------------------------------------- who sells, and when */

export type BidReason = 'bidder' | 'desk' | 'treasury' | 'treasury-desperate' | 'cross-holding';

export interface BidReservation {
	/** At or above this price the holder tenders. Never below the price floor. */
	price: number;
	reason: BidReason;
}

export interface BidJudgement extends BidReservation {
	holderId: string;
	name: string;
	quantity: number;
	accepts: boolean;
	/** Shares this holder actually gives up: zero if it refuses, or if the block filled first. */
	tendering: number;
}

/**
 * Everything the rules need about a target, gathered once so that judging itself is pure and
 * touches no database. That is what lets the screen re-price a dragged slider synchronously,
 * and it is why the preview a player reads is exactly the outcome they get.
 */
export interface BidContext {
	/** Desk temperaments by `b:N` holder id. */
	deskTemperaments: Map<string, BrokerTemperament>;
	/** Cash held by each `c:N` holder on the register, including the target's own. */
	holderCash: Map<string, number>;
	quotedSharePrice: number;
	bookValuePerShare: number;
	cashRunwayDays: number | null;
}

/** The lowest price a bid is allowed to offer. */
export const minimumBidPrice = (quotedSharePrice: number): number =>
	Math.max(MIN_SHARE_PRICE, Math.round(quotedSharePrice * MIN_BID_PREMIUM));

/**
 * Headroom over today's control price that the screen offers as its default.
 *
 * A bid is judged against the register as it stands when it closes, not as it stood when it
 * was launched, and a board's reservation moves with its book value — which drifts on its own
 * as the airline trades, quite apart from anything the board does to fight the offer. Bidding
 * the exact figure the screen quotes would therefore be a coin flip, and losing it costs the
 * advisers' fee. This is what makes the default price one that survives an ordinary few days.
 */
export const RECOMMENDED_BID_MARGIN = 1.1;

/** A price with enough headroom to survive the days between launching a bid and closing it. */
export const recommendedBidPrice = (controlPrice: number, quotedSharePrice: number): number =>
	Math.max(minimumBidPrice(quotedSharePrice), Math.round(controlPrice * RECOMMENDED_BID_MARGIN));

/** Floored at the price band's bottom: no share changes hands below the floor anywhere else. */
const floored = (price: number): number => Math.max(MIN_SHARE_PRICE, Math.round(price));

/**
 * The price at which a holder will part with its shares.
 *
 * Every rule is a multiple of book value, and every input is either persisted state or seeded
 * on a permanently stable key — there is no randomness in this path at all. A board's own
 * reservation is the only one that moves with circumstance, and it moves on the same cash
 * line that decides whether the airline floats shares in the first place.
 */
export const reservationPriceFor = (
	holder: Pick<ShareholderRow, 'holderId' | 'quantity' | 'isTreasury'>,
	bidderHolderId: string,
	context: BidContext
): BidReservation => {
	if (holder.holderId === bidderHolderId) {
		return { price: Number.POSITIVE_INFINITY, reason: 'bidder' };
	}

	const book = context.bookValuePerShare;

	const deskId = holderBrokerId(holder.holderId);
	if (deskId !== null) {
		const temperament = context.deskTemperaments.get(holder.holderId);

		// A desk with no temperament to read is one whose row has gone; treat it as holding out
		// at its most expensive rather than as a free seller.
		const target = temperament
			? book * temperament.profitTakeMultiplier
			: book * TREASURY_RESERVATION;

		return {
			price: floored(Math.max(target, context.quotedSharePrice * DESK_BID_PREMIUM)),
			reason: 'desk'
		};
	}

	if (holder.isTreasury) {
		const desperate =
			context.cashRunwayDays !== null && context.cashRunwayDays < DESPERATE_RUNWAY_DAYS;

		return desperate
			? { price: floored(book * DESPERATE_TREASURY_RESERVATION), reason: 'treasury-desperate' }
			: { price: floored(book * TREASURY_RESERVATION), reason: 'treasury' };
	}

	if (holderCompanyId(holder.holderId) !== null) {
		const cash = context.holderCash.get(holder.holderId) ?? 0;
		const multiple =
			cash < CASH_FLOOR ? DESPERATE_CROSS_HOLDING_RESERVATION : CROSS_HOLDING_RESERVATION;

		return { price: floored(book * multiple), reason: 'cross-holding' };
	}

	// Another player-held id — nothing in the game produces one today, and a holder the rules
	// cannot read is one that does not sell.
	return { price: Number.POSITIVE_INFINITY, reason: 'bidder' };
};

/**
 * What every name on the register does when the offer is put to them, and how an
 * oversubscribed block is shared out: the willing are bought first, cheapest reservation
 * before dearest, and the holder the block runs out on is filled part-way — which is how a
 * real oversubscribed tender pro-rates. Ties break on holding size and then on holder id, so
 * that a register the database happened to return in a different order still resolves the
 * same way.
 */
export const judgeRegister = (
	register: ShareholderRow[],
	bidderHolderId: string,
	pricePerShare: number,
	sharesSought: number,
	context: BidContext
): BidJudgement[] => {
	const judged = register.map((holder) => {
		const reservation = reservationPriceFor(holder, bidderHolderId, context);

		return {
			...reservation,
			holderId: holder.holderId,
			name: holder.name,
			quantity: holder.quantity,
			accepts: holder.quantity > 0 && reservation.price <= pricePerShare,
			tendering: 0
		};
	});

	const queue = judged
		.filter((judgement) => judgement.accepts)
		.sort(
			(left, right) =>
				left.price - right.price ||
				right.quantity - left.quantity ||
				left.holderId.localeCompare(right.holderId)
		);

	let remaining = Math.max(0, sharesSought);
	for (const judgement of queue) {
		if (remaining <= 0) break;
		judgement.tendering = Math.min(judgement.quantity, remaining);
		remaining -= judgement.tendering;
	}

	return judged;
};

/**
 * The cheapest price at which enough of the register would tender to hand the bidder a
 * majority, or null when no price reaches one. This is the single number that makes the
 * takeover screen legible: without it a player is dragging a slider blind.
 *
 * Every distinct reservation price is a candidate, because the set of willing sellers only
 * changes as the offer crosses one of them.
 */
export const priceForControl = (
	register: ShareholderRow[],
	bidderHolderId: string,
	bidderShares: number,
	context: BidContext
): number | null => {
	const reservations = register
		.filter((holder) => holder.holderId !== bidderHolderId && holder.quantity > 0)
		.map((holder) => reservationPriceFor(holder, bidderHolderId, context).price)
		.filter((price) => Number.isFinite(price));

	const candidates = [...new Set(reservations)].sort((left, right) => left - right);

	for (const candidate of candidates) {
		const winnable = register
			.filter(
				(holder) =>
					holder.holderId !== bidderHolderId &&
					reservationPriceFor(holder, bidderHolderId, context).price <= candidate
			)
			.reduce((sum, holder) => sum + holder.quantity, 0);

		if (bidderShares + winnable > CONTROL_THRESHOLD) return candidate;
	}

	return null;
};

/* ------------------------------------------------------------------ reading a target */

/**
 * Gathers the world state the rules need. One pass over the register: a desk's temperament
 * comes off its own row, and an airline holder's cash off its balance sheet.
 */
export const bidContextFor = async (dossier: CompanyDossier): Promise<BidContext> => {
	const deskTemperaments = new Map<string, BrokerTemperament>();
	const holderCash = new Map<string, number>();

	for (const row of dossier.register) {
		const deskId = holderBrokerId(row.holderId);
		if (deskId !== null) {
			const broker = await db.brokers.get(deskId);
			if (broker) deskTemperaments.set(row.holderId, temperamentOf(broker));
			continue;
		}

		const companyId = holderCompanyId(row.holderId);
		if (companyId !== null) {
			const company = await db.companies.get(companyId);
			if (company) holderCash.set(row.holderId, company.cash);
		}
	}

	return {
		deskTemperaments,
		holderCash,
		quotedSharePrice: dossier.valuation.sharePrice,
		bookValuePerShare: dossier.bookValuePerShare,
		cashRunwayDays: dossier.cashRunwayDays
	};
};

/* -------------------------------------------------------------------- the preview */

export interface BidPreview {
	companyId: number;
	bidderHolderId: string;
	quotedSharePrice: number;
	bookValuePerShare: number;
	minimumPrice: number;
	/** Cheapest price a majority is reachable at today, or null if the register cannot supply one. */
	controlPrice: number | null;
	/** What the screen offers by default: the control price with headroom for the days ahead. */
	suggestedPrice: number | null;
	bidderShares: number;
	sharesOutstanding: number;
	sharesForControl: number;
	closesDay: number;
	openBid: TakeoverBid | null;
	lockedOutUntilDay: number | null;
	/** Anything that would make `openTakeoverBid` throw, in words a panel can print. */
	blockers: string[];
}

export interface BidQuote {
	pricePerShare: number;
	sharesSought: number;
	escrow: number;
	judgements: BidJudgement[];
	sharesWinnable: number;
	sharesAfter: number;
	wouldTakeControl: boolean;
	/** What the offer would actually spend, as opposed to what it escrows. */
	spend: number;
}

/**
 * Everything the takeover panel needs about a target, read once. The judging itself is left to
 * `quoteBid`, which is pure — so dragging the price slider re-prices the offer without going
 * near the database.
 */
export const previewBid = async (
	companyId: number,
	bidderHolderId: string,
	dossier: CompanyDossier,
	bidderCompanyId: number | null
): Promise<{ preview: BidPreview; context: BidContext }> => {
	const context = await bidContextFor(dossier);
	const bidderShares = dossier.register.find((row) => row.holderId === bidderHolderId)?.quantity ?? 0;
	const controlPrice = priceForControl(dossier.register, bidderHolderId, bidderShares, context);
	const today = dayIndexOf(gameNow());

	const blockers: string[] = [];
	if (bidderShares > CONTROL_THRESHOLD) blockers.push('You already control this airline');
	if (bidderCompanyId === null) blockers.push('You need an airline of your own to bank the offer');
	if (bidderCompanyId === companyId) blockers.push('An airline cannot bid for itself');
	if (dossier.openBid) blockers.push('There is already an offer open for this airline');

	const lockout = dossier.bidLockoutUntilDay;
	if (lockout !== null && today < lockout) {
		blockers.push(`The board has barred a fresh offer for ${lockout - today} more day(s)`);
	}

	return {
		preview: {
			companyId,
			bidderHolderId,
			quotedSharePrice: dossier.valuation.sharePrice,
			bookValuePerShare: dossier.bookValuePerShare,
			minimumPrice: minimumBidPrice(dossier.valuation.sharePrice),
			controlPrice,
			suggestedPrice:
				controlPrice === null
					? null
					: recommendedBidPrice(controlPrice, dossier.valuation.sharePrice),
			bidderShares,
			sharesOutstanding: TOTAL_SHARES - bidderShares,
			sharesForControl: sharesForControl(bidderShares),
			closesDay: today + BID_WINDOW_DAYS,
			openBid: dossier.openBid,
			lockedOutUntilDay: lockout,
			blockers
		},
		context
	};
};

/** Pure: what this price and this block size would execute as, if the register held still. */
export const quoteBid = (
	dossier: CompanyDossier,
	context: BidContext,
	bidderHolderId: string,
	pricePerShare: number,
	sharesSought: number
): BidQuote => {
	const judgements = judgeRegister(
		dossier.register,
		bidderHolderId,
		pricePerShare,
		sharesSought,
		context
	);

	const sharesWinnable = judgements.reduce((sum, row) => sum + row.tendering, 0);
	const bidderShares =
		dossier.register.find((row) => row.holderId === bidderHolderId)?.quantity ?? 0;

	return {
		pricePerShare,
		sharesSought,
		escrow: pricePerShare * sharesSought,
		judgements,
		sharesWinnable,
		sharesAfter: bidderShares + sharesWinnable,
		wouldTakeControl: bidderShares + sharesWinnable > CONTROL_THRESHOLD,
		spend: sharesWinnable * pricePerShare
	};
};

/* ------------------------------------------------------------------- the defences */

/** How far a rumoured bid re-rates the stock on the day it becomes public. */
export const BID_RUMOUR_SPIKE = 1.15;

/** Sentiment left behind once the uncertainty resolves, won or lost. */
export const POST_SUCCESS_DRIFT = 0.92;
export const POST_FAILURE_DRIFT = 0.85;

/** Days of runway a board needs before it will spend cash fighting rather than hoarding it. */
const DEFENCE_RUNWAY_COMFORTABLE = 25;

/** Most shares a board will recover in a single day. */
export const DEFENCE_MAX_SHARES = 300;

const clampMultiplier = (value: number): number =>
	Math.min(MARKET_MULTIPLIER_MAX, Math.max(MARKET_MULTIPLIER_MIN, value));

/**
 * One evening of the board fighting the offer. At most one action a night, chosen by what the
 * airline can actually afford rather than by preference, so a defence always costs the
 * defender something real.
 *
 * A board about to run out of cash can do none of it and its own float tenders — which is what
 * makes starving a rival before bidding for it a complete strategy rather than a hope.
 *
 * There is deliberately no placing of shares with a friendly desk here, tempting as the move
 * is. A board's reservation price is a multiple of its book value, so raising cash by selling
 * a block cheaply would raise its own asking price — leaving it refusing a bid it had just
 * undercut itself on, which is not something a player could be expected to read as anything
 * but a bug.
 */
export const runBidDefence = async (
	bid: TakeoverBid,
	dossier: CompanyDossier,
	dayIndex: number,
	rng: Rng
): Promise<string | null> => {
	const companyId = dossier.company.id;
	const desperate =
		dossier.cashRunwayDays !== null && dossier.cashRunwayDays < DESPERATE_RUNWAY_DAYS;
	if (desperate) return null;

	// The night the offer becomes public, before the board has done anything about it.
	if (dayIndex === bid.openedDay + 1) {
		const multiplier = clampMultiplier(dossier.marketMultiplier * BID_RUMOUR_SPIKE);
		await db.companies.update(companyId, { marketMultiplier: multiplier });

		return 'Rumours of an offer; the shares were re-rated upward';
	}

	const comfortable =
		dossier.cashRunwayDays === null || dossier.cashRunwayDays >= DEFENCE_RUNWAY_COMFORTABLE;

	if (comfortable && dossier.sharesForSale > 0) {
		const ceiling = Math.round(bid.pricePerShare * (0.9 + rng() * 0.1));
		const bought = await buyBackOwnFloat(companyId, DEFENCE_MAX_SHARES, ceiling);
		if (bought > 0) return `The board bought ${bought} shares of its own float back`;
	}

	// Short of cash, or nothing on the market to recover: the board can only watch.
	return null;
};

/* ------------------------------------------------------------------- resolution */

export interface BidOutcome {
	bidId: number;
	targetIcao: string;
	targetName: string;
	status: BidStatus;
	sharesWon: number;
	spent: number;
	refunded: number;
	defence: string | null;
	tookControl: boolean;
}

/** What the escrow returns after the advisers have taken their cut of the unspent part. */
export const refundFor = (escrow: number, spent: number): number =>
	Math.max(0, Math.round((escrow - spent) * (1 - BID_FEE_SHARE)));

/**
 * Puts the offer to the register and settles whatever comes back. The register is read now,
 * not when the bid was opened: the board has had days to change it, and it may well have.
 */
export const resolveBid = async (
	bid: TakeoverBid,
	dossier: CompanyDossier
): Promise<BidOutcome> => {
	const context = await bidContextFor(dossier);
	const bidderShares = await sharesHeldBy(bid.targetCompanyId, bid.bidderHolderId);

	const judged = judgeRegister(
		dossier.register,
		bid.bidderHolderId,
		bid.pricePerShare,
		bid.sharesSought,
		context
	);

	let spent = 0;
	for (const judgement of judged) {
		if (judgement.tendering <= 0) continue;
		spent += await settleBidTender(bid, judgement.holderId, judgement.tendering);
	}

	// Counted off the register rather than by adding up the plan: `settleBidTender` clamps to
	// what each holder still actually had, so the plan is an intention and the register is the
	// only truth about what moved.
	const afterShares = await sharesHeldBy(bid.targetCompanyId, bid.bidderHolderId);
	const won = afterShares - bidderShares;
	const tookControl = afterShares > CONTROL_THRESHOLD;

	const status: BidStatus = tookControl ? 'succeeded' : won > 0 ? 'partial' : 'failed';
	const refund = refundFor(bid.escrow, spent);

	const drift = won > 0 ? POST_SUCCESS_DRIFT : POST_FAILURE_DRIFT;
	await db.companies.update(bid.targetCompanyId, {
		marketMultiplier: clampMultiplier(dossier.marketMultiplier * drift)
	});

	// Only a bid that won nothing at all hardens the board against another. A bidder left
	// holding a large minority is allowed to come back and top it up.
	if (won === 0) {
		await setBidLockout(bid.targetCompanyId, dayIndexOf(gameNow()) + BID_LOCKOUT_DAYS);
	}

	await closeTakeoverBid(bid, status, won, refund);

	return {
		bidId: bid.id,
		targetIcao: dossier.company.icao,
		targetName: dossier.company.name,
		status,
		sharesWon: won,
		spent,
		refunded: refund,
		defence: bid.defence,
		tookControl
	};
};

/**
 * Pulls an offer before it closes. Nothing was ever spent, so the whole escrow comes back less
 * the advisers' fee — which is what stops a bidder opening offers purely to read a register and
 * withdrawing the moment they have.
 */
export const withdrawBid = async (bidId: number): Promise<number> => {
	const bid = await withdrawTakeoverBid(bidId);
	const refund = refundFor(bid.escrow, 0);

	await closeTakeoverBid(bid, 'withdrawn', 0, refund);

	return refund;
};

/**
 * One day of takeover activity: every open bid gets a night of the board fighting it, and
 * every bid whose window has run out is put to the register.
 *
 * A dossier is the most expensive read in a day close, so one is built per open bid — normally
 * none at all, which is what keeps the feature free on the days nobody is bidding.
 */
export const runBidDay = async (dayIndex: number): Promise<BidOutcome[]> => {
	const open = (await db.takeover_bids.where('status').equals('open').toArray()).sort(
		(left, right) => left.id - right.id
	);
	if (open.length === 0) return [];

	for (const bid of open) {
		if (bid.closesDay <= dayIndex) continue;

		const dossier = await companyDossier(bid.targetCompanyId, bid.bidderHolderId);
		if (!dossier) continue;

		const rng = seededRng('takeover-defence', bid.targetCompanyId, dayIndex);
		const defence = await runBidDefence(bid, dossier, dayIndex, rng);
		if (defence) await recordBidDefence(bid.id, defence);
	}

	const outcomes: BidOutcome[] = [];
	for (const due of await bidsDueBy(dayIndex)) {
		const dossier = await companyDossier(due.targetCompanyId, due.bidderHolderId);
		if (!dossier) continue;

		outcomes.push(await resolveBid(due, dossier));
	}

	return outcomes;
};
