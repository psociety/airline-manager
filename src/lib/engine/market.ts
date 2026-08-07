import {
	companyGates,
	pendingIncidents,
	recentShareTrades,
	shareRegister,
	transactionsBetweenDays,
	type ShareholderRow
} from '$db/repo';
import {
	CONTROL_THRESHOLD,
	PLAYER_HOLDER_ID,
	TOTAL_SHARES,
	db,
	holderCompanyId,
	type Company,
	type ShareListing,
	type ShareTrade,
	type TakeoverBid
} from '$db/schema';
import { dayIndexOf, gameNow } from './clock';
import {
	MARKET_MULTIPLIER_MAX,
	MARKET_MULTIPLIER_MIN,
	MIN_SHARE_PRICE,
	assetBreakdown,
	dailyLeaseBill,
	dailyWageBill,
	valuation,
	type AssetBreakdown,
	type Valuation
} from './economy';
import {
	groupByDay,
	summariseLedger,
	trailingWindow,
	type DaySummary,
	type ProfitAndLoss
} from './ledger';

/* ------------------------------------------------------------- the order book */

export interface OrderFill {
	listingId: number;
	quantity: number;
	pricePerShare: number;
}

export interface OrderPlan {
	fills: OrderFill[];
	filled: number;
	/** Shares the book could not supply. Anything above zero means the order cannot run. */
	shortfall: number;
	total: number;
	/** Weighted by what each fill costs, so it is the price actually paid. Null if nothing fills. */
	averagePricePerShare: number | null;
}

const EMPTY_PLAN: OrderPlan = {
	fills: [],
	filled: 0,
	shortfall: 0,
	total: 0,
	averagePricePerShare: null
};

export type AskListing = Pick<ShareListing, 'id' | 'quantity' | 'pricePerShare' | 'sellerId'>;

/**
 * Walks the asks cheapest first and reports exactly what an order would execute as.
 * Sorts a copy, so no caller has to pre-sort, and skips `excludeSellerId`'s own asks —
 * buying your own listing is refused further down, and quoting a total that includes it
 * would price an order that can never run.
 */
export const fillOrder = (
	listings: AskListing[],
	quantity: number,
	excludeSellerId?: string
): OrderPlan => {
	if (quantity <= 0) return EMPTY_PLAN;

	const asks = listings
		.filter((listing) => listing.sellerId !== excludeSellerId)
		.slice()
		.sort((left, right) => left.pricePerShare - right.pricePerShare);

	const fills: OrderFill[] = [];
	let remaining = quantity;
	let total = 0;

	for (const ask of asks) {
		if (remaining <= 0) break;
		const take = Math.min(remaining, ask.quantity);
		fills.push({ listingId: ask.id, quantity: take, pricePerShare: ask.pricePerShare });
		total += take * ask.pricePerShare;
		remaining -= take;
	}

	const filled = quantity - remaining;

	return {
		fills,
		filled,
		shortfall: remaining,
		total,
		averagePricePerShare: filled > 0 ? total / filled : null
	};
};

/**
 * Shares still needed to control an airline. Control is a strict majority, so it takes
 * 1.501 of the 3.000 from a standing start, not 1.500.
 */
export const sharesForControl = (held: number): number =>
	Math.max(0, CONTROL_THRESHOLD + 1 - held);

/**
 * How far above book an ask sits, as a ratio: 1,2 means a fifth over book. Null unless
 * book value is positive — an overdrawn airline has a negative book value, and dividing
 * by it would turn an expensive ask into an apparent bargain.
 */
export const premiumToBook = (pricePerShare: number, bookValuePerShare: number): number | null =>
	bookValuePerShare > 0 ? pricePerShare / bookValuePerShare : null;

/* ----------------------------------------------------------------- the dossier */

/** Leases have no end date in this game, so a year is a stated yardstick, not a valuation. */
export const LEASE_HORIZON_DAYS = 365;

export interface DossierListing extends ShareListing {
	sellerName: string;
	isTreasury: boolean;
	premiumToBook: number | null;
}

export interface ControlCost {
	sharesNeeded: number;
	plan: OrderPlan;
	/** False when the book cannot supply a controlling stake at any price. */
	attainable: boolean;
	alreadyInControl: boolean;
}

export interface CompanyDossier {
	company: Company;
	valuation: Valuation;
	assets: AssetBreakdown;
	bookValuePerShare: number;
	/** The model's own quote against book — in effect the airline's market sentiment. */
	quotePremiumToBook: number | null;
	/** The cheapest ask against book: what a buyer would actually pay over the assets. */
	askPremiumToBook: number | null;
	marketMultiplier: number;
	multiplierBand: { min: number; max: number };
	/**
	 * True when book value times sentiment falls under the floor, so the quoted share
	 * price is the floor rather than anything to do with the airline's worth.
	 */
	priceFloorBinding: boolean;
	pnl: ProfitAndLoss;
	days: DaySummary[];
	dailyWages: number;
	dailyLeases: number;
	dailyFixedCosts: number;
	/** Days the balance covers its fixed costs. Null when there are none to cover. */
	cashRunwayDays: number | null;
	annualisedLeaseExposure: number;
	pendingIncidentCount: number;
	pendingIncidentExposure: number;
	listings: DossierListing[];
	sharesForSale: number;
	cheapestAsk: number | null;
	register: ShareholderRow[];
	viewerShares: number;
	viewerStake: number;
	control: ControlCost;
	recentTrades: ShareTrade[];
	/**
	 * The takeover offer standing against this airline, if any. Carried as the stored row and
	 * nothing more: what a bid would win is worked out in `takeover.ts`, which reads this
	 * dossier, so judging it here would turn a one-way dependency into a cycle.
	 */
	openBid: TakeoverBid | null;
	/** Day until which the board has barred a fresh offer, or null if it has not. */
	bidLockoutUntilDay: number | null;
}

/**
 * Everything a buyer needs to judge an airline's asking price: what it owns, what it
 * earns, what it owes each day, and what the book is offering.
 *
 * Reads the company itself before anything else, because a bad id has to come back as a
 * null the page can render an empty state for — the valuation helpers throw instead.
 */
export const companyDossier = async (
	companyId: number,
	viewerHolderId = PLAYER_HOLDER_ID
): Promise<CompanyDossier | null> => {
	if (!Number.isInteger(companyId)) return null;

	const company = await db.companies.get(companyId);
	if (!company) return null;

	const [fleet, gates, routeCount, listings, register, incidents, recentTrades, openBids] =
		await Promise.all([
			db.aircraft.where('companyId').equals(companyId).toArray(),
			companyGates(companyId),
			db.routes.where('companyId').equals(companyId).count(),
			db.share_listings.where('companyId').equals(companyId).toArray(),
			shareRegister(companyId, viewerHolderId),
			pendingIncidents(companyId),
			recentShareTrades(companyId),
			db.takeover_bids.where('[targetCompanyId+status]').equals([companyId, 'open']).toArray()
		]);

	const inputs = { company, fleet, gates, routeCount };
	const assets = assetBreakdown(inputs);
	const priced = valuation(inputs, company.marketMultiplier);
	const bookValuePerShare = priced.bookValue;

	const window = trailingWindow(
		dayIndexOf(gameNow()),
		undefined,
		dayIndexOf(company.createdAt)
	);
	const records = await transactionsBetweenDays(companyId, window.fromDay, window.toDay);

	const dailyWages = dailyWageBill(company);
	const dailyLeases = dailyLeaseBill(fleet);
	const dailyFixedCosts = dailyWages + dailyLeases;

	const sorted = listings.slice().sort((left, right) => left.pricePerShare - right.pricePerShare);
	const cheapestAsk = sorted[0]?.pricePerShare ?? null;
	const viewerShares = register.find((row) => row.isViewer)?.quantity ?? 0;
	const sharesNeeded = sharesForControl(viewerShares);
	const controlPlan = fillOrder(sorted, sharesNeeded, viewerHolderId);

	return {
		company,
		valuation: priced,
		assets,
		bookValuePerShare,
		quotePremiumToBook: premiumToBook(priced.sharePrice, bookValuePerShare),
		askPremiumToBook:
			cheapestAsk === null ? null : premiumToBook(cheapestAsk, bookValuePerShare),
		marketMultiplier: company.marketMultiplier,
		multiplierBand: { min: MARKET_MULTIPLIER_MIN, max: MARKET_MULTIPLIER_MAX },
		priceFloorBinding: bookValuePerShare * company.marketMultiplier < MIN_SHARE_PRICE,
		pnl: summariseLedger(records, window),
		days: groupByDay(records),
		dailyWages,
		dailyLeases,
		dailyFixedCosts,
		cashRunwayDays:
			dailyFixedCosts > 0 ? Math.max(0, company.cash) / dailyFixedCosts : null,
		annualisedLeaseExposure: dailyLeases * LEASE_HORIZON_DAYS,
		pendingIncidentCount: incidents.length,
		pendingIncidentExposure: incidents.reduce((sum, incident) => sum + incident.baseAmount, 0),
		listings: sorted.map((listing) => ({
			...listing,
			sellerName: register.find((row) => row.holderId === listing.sellerId)?.name ?? listing.sellerId,
			isTreasury: holderCompanyId(listing.sellerId) === companyId,
			premiumToBook: premiumToBook(listing.pricePerShare, bookValuePerShare)
		})),
		sharesForSale: sorted.reduce((sum, listing) => sum + listing.quantity, 0),
		cheapestAsk,
		register,
		viewerShares,
		viewerStake: viewerShares / TOTAL_SHARES,
		control: {
			sharesNeeded,
			plan: controlPlan,
			attainable: sharesNeeded > 0 && controlPlan.shortfall === 0,
			alreadyInControl: sharesNeeded === 0
		},
		recentTrades,
		openBid: openBids[0] ?? null,
		bidLockoutUntilDay: company.bidLockoutUntilDay ?? null
	};
};
