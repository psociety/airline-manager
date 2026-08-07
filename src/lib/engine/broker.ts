import { companyValuation, fillListingAsBroker, listSharesForSale } from '$db/repo';
import {
	CONTROL_THRESHOLD,
	brokerHolderId,
	db,
	type Broker,
	type ShareListing
} from '$db/schema';
import { MIN_SHARE_PRICE } from './economy';
import { companyDossier, fillOrder, type CompanyDossier } from './market';
import { randomIntBetween, seededRng, type Rng } from './rng';

/**
 * Sentiment at which a desk stops buying. The multiplier band mean-reverts, so paying up
 * near the top of it is paying for froth that is about to drain away.
 */
const MULTIPLIER_TOO_HOT = 1.5;

/** Below this many days of fixed costs covered, a carrier is a wreck rather than a bargain. */
const RUNWAY_TOO_SHORT = 20;

/**
 * The dossier is public information — every desk reads the same filing — so one is built
 * per airline per day under this name and shared. A desk's own position comes off the
 * register instead of the viewer fields.
 */
const SHARED_VIEWER = 'broker-desk';

export interface BrokerTemperament {
	/**
	 * The most it will pay for a sound airline, as a multiple of book value. Comfortably
	 * above one, for two reasons: a business worth running is worth more than its balance
	 * sheet, and this is the figure every deduction below comes off — a base set at book
	 * would leave nothing to deduct from and no airline a desk would ever buy.
	 */
	assetCeiling: number;
	/** Shares it will buy in one day, across every airline together. */
	dailyShareCap: number;
	/** Odds it looks at the market at all on a given day. */
	engagementChance: number;
	/** Sentiment at which it starts taking profits. */
	profitTakeMultiplier: number;
}

/**
 * A desk's standing character. Seeded on its key and never on the day, because the daily
 * stream is reseeded every morning: a trait rolled fresh each day would average all four
 * desks into the same middling trader within a fortnight.
 */
export const temperamentOf = (broker: Broker): BrokerTemperament => {
	const trait = seededRng('broker-temperament', broker.key);

	return {
		assetCeiling: 1.15 + trait() * 0.25,
		dailyShareCap: 120 + Math.floor(trait() * 240),
		engagementChance: 0.45 + trait() * 0.45,
		profitTakeMultiplier: 1.25 + trait() * 0.3
	};
};

/**
 * Whether the assets behind the shares are impaired rather than merely cheap. Only
 * obligations big enough to swallow the balance sheet count: the quoted price is drawn from
 * assets alone and never subtracts either of these, which is the whole reason a desk reads
 * the filing instead of the quote.
 *
 * Deliberately says nothing about running out of cash. An airline floats shares precisely
 * because it is short of cash, so treating that as disqualifying would refuse every seller
 * in the market — being illiquid is why the stock is for sale, not a reason to refuse it.
 * Thin cash shows up in the price a desk will pay instead, through `ceilingFor`.
 */
export const isWreck = (dossier: CompanyDossier): boolean => {
	if (dossier.pendingIncidentExposure > dossier.assets.total * 0.5) return true;

	// A year is only a yardstick — leases in this game have no end date — so it takes a
	// commitment at twice the whole balance sheet to write an airline off on this alone.
	// Merely lease-heavy carriers are priced down instead, not refused.
	return dossier.annualisedLeaseExposure > dossier.assets.total * 2;
};

/**
 * What this desk will pay for this airline, as a multiple of book. It starts from the desk's
 * own confidence and takes a slice off for every weakness in the filing — a bleeding
 * carrier has to be cheaper before a desk will touch it. Never drops so far that a badly
 * beaten airline becomes untouchable at any price.
 */
export const ceilingFor = (dossier: CompanyDossier, temperament: BrokerTemperament): number => {
	let ceiling = temperament.assetCeiling;

	if (dossier.pnl.dailyOperatingResult < 0) ceiling -= 0.1;
	if (dossier.cashRunwayDays !== null && dossier.cashRunwayDays < RUNWAY_TOO_SHORT) ceiling -= 0.08;
	if (dossier.pendingIncidentExposure > dossier.assets.total * 0.25) ceiling -= 0.12;
	if (dossier.annualisedLeaseExposure > dossier.assets.total) ceiling -= 0.1;

	return Math.max(0.7, ceiling);
};

/** Reasons a desk would pass on an airline whatever the price. */
const worthReading = (dossier: CompanyDossier): boolean => {
	// A quote sitting on its floor says nothing about what the airline is worth, so every
	// premium measured against it is fiction.
	if (dossier.priceFloorBinding) return false;
	if (dossier.bookValuePerShare <= 0) return false;
	if (dossier.marketMultiplier >= MULTIPLIER_TOO_HOT) return false;

	return !isWreck(dossier);
};

const heldBy = (dossier: CompanyDossier, holderId: string): number =>
	dossier.register.find((row) => row.holderId === holderId)?.quantity ?? 0;

const asksFrom = async (companyId: number): Promise<ShareListing[]> =>
	db.share_listings.where('companyId').equals(companyId).toArray();

/**
 * Puts a position on the market, or reprices the ask already there. One ask per desk per
 * airline keeps the order book legible, and repricing is safe where withdrawing is not:
 * `cancelListing` checks no ownership at all, so broker code never calls it.
 */
const listOrReprice = async (
	dossier: CompanyDossier,
	holderId: string,
	quantity: number,
	pricePerShare: number
): Promise<void> => {
	const existing = (await asksFrom(dossier.company.id)).find(
		(listing) => listing.sellerId === holderId
	);

	if (existing) {
		await db.share_listings.update(existing.id, { pricePerShare });
		return;
	}

	if (quantity <= 0) return;
	await listSharesForSale(dossier.company.id, holderId, quantity, pricePerShare);
};

/**
 * Take profits when sentiment has run hot, or cut a position that has gone bad. Prices are
 * clamped because `listSharesForSale` validates neither price nor quantity, and a share
 * never quotes below the floor.
 */
const sellPass = async (
	broker: Broker,
	dossiers: CompanyDossier[],
	rng: Rng,
	temperament: BrokerTemperament
): Promise<void> => {
	const holderId = brokerHolderId(broker.id);

	for (const dossier of dossiers) {
		const held = heldBy(dossier, holderId);
		if (held <= 0) continue;

		const hot = dossier.marketMultiplier >= temperament.profitTakeMultiplier;
		const failing = isWreck(dossier);
		if (!hot && !failing) continue;

		const asks = await asksFrom(dossier.company.id);
		const alreadyListed = asks
			.filter((listing) => listing.sellerId === holderId)
			.reduce((sum, listing) => sum + listing.quantity, 0);

		const factor = hot ? 1 + rng() * 0.08 : 0.85 + rng() * 0.08;
		const price = Math.max(
			MIN_SHARE_PRICE,
			Math.round(dossier.valuation.sharePrice * factor)
		);
		const quantity = Math.min(
			held - alreadyListed,
			randomIntBetween(rng, 50, temperament.dailyShareCap)
		);

		await listOrReprice(dossier, holderId, quantity, price);
	}
};

/**
 * Buy what is cheap against book, from airlines whose filings stand up. The daily cap is a
 * budget spent across every airline together, not per airline.
 */
const buyPass = async (
	broker: Broker,
	dossiers: CompanyDossier[],
	rng: Rng,
	temperament: BrokerTemperament
): Promise<void> => {
	const holderId = brokerHolderId(broker.id);
	let budget = temperament.dailyShareCap;

	for (const dossier of dossiers) {
		if (budget <= 0) break;
		if (!worthReading(dossier)) continue;

		const room = CONTROL_THRESHOLD - heldBy(dossier, holderId);
		if (room <= 0) continue;

		const ceiling = ceilingFor(dossier, temperament) * dossier.bookValuePerShare;

		// Re-read the book: desks earlier in the loop may already have taken these asks, and
		// desks selling this morning may have added new ones.
		const qualifying = (await asksFrom(dossier.company.id)).filter(
			(listing) => listing.sellerId !== holderId && listing.pricePerShare <= ceiling
		);
		if (qualifying.length === 0) continue;

		// Rolled against the whole cap rather than what is left, so the draw does not depend
		// on how many airlines happened to come earlier in the list.
		const appetite = randomIntBetween(rng, 25, temperament.dailyShareCap);
		const plan = fillOrder(qualifying, Math.min(room, budget, appetite), holderId);

		for (const fill of plan.fills) {
			try {
				await fillListingAsBroker(fill.listingId, holderId, fill.quantity);
				budget -= fill.quantity;
			} catch {
				// Another desk took it first, or the cap bit. There will be another tomorrow.
			}
		}
	}
};

/**
 * How many airlines get a full filing in one day. A dossier costs a dozen indexed reads and
 * a four-week ledger scan, so reading every airline every day is by far the most expensive
 * thing in a day close — and a thirty-day catch-up multiplies it. Desks read the most
 * promising few instead, which is also how a real desk works.
 */
const FILINGS_PER_DAY = 6;

/**
 * Airlines worth a filing today: someone is asking, or a desk already holds a position.
 * Ranked by how cheap the ask looks against book so the daily budget of filings goes to the
 * most promising names. Ranking uses `companyValuation`, which skips the ledger entirely and
 * so costs a fraction of a full dossier.
 */
const candidateIds = async (brokerHolderIds: string[]): Promise<number[]> => {
	const [listings, holdings] = await Promise.all([
		db.share_listings.toArray(),
		db.shareholdings.where('holderId').anyOf(brokerHolderIds).toArray()
	]);

	const ids = new Set<number>();
	for (const listing of listings) ids.add(listing.companyId);
	for (const holding of holdings) ids.add(holding.companyId);

	const ranked = await Promise.all(
		[...ids].map(async (companyId) => {
			const asks = listings.filter((listing) => listing.companyId === companyId);
			const cheapest = asks.reduce(
				(low, listing) => Math.min(low, listing.pricePerShare),
				Number.POSITIVE_INFINITY
			);
			const { bookValue } = await companyValuation(companyId);

			// Positions already held rank alongside a fairly priced ask, so a desk keeps
			// reviewing what it owns even on a day when nobody is asking cheaply.
			const cheapness =
				Number.isFinite(cheapest) && bookValue > 0 ? cheapest / bookValue : 1;

			return { companyId, cheapness };
		})
	);

	return ranked
		.sort((left, right) => left.cheapness - right.cheapness || left.companyId - right.companyId)
		.slice(0, FILINGS_PER_DAY)
		.map((entry) => entry.companyId)
		.sort((left, right) => left - right);
};

/**
 * One day of trading for every broker desk. Runs after the airlines have had their turn,
 * because that is when the day's asks appear — a desk going first would only ever see
 * yesterday's book. Guarded by `lastBrokerDay`, so a ten-day catch-up trades ten times.
 */
export const runBrokerDay = async (dayIndex: number): Promise<number> => {
	const brokers = (await db.brokers.toArray())
		.filter((broker) => broker.lastBrokerDay < dayIndex)
		.sort((left, right) => left.id - right.id);
	if (brokers.length === 0) return 0;

	const ids = await candidateIds(brokers.map((broker) => brokerHolderId(broker.id)));
	if (ids.length === 0) {
		// Still a turn taken: nothing to look at is a decision like any other.
		for (const broker of brokers) {
			await db.brokers.update(broker.id, { lastBrokerDay: dayIndex });
		}
		return brokers.length;
	}

	const dossiers = (
		await Promise.all(ids.map((companyId) => companyDossier(companyId, SHARED_VIEWER)))
	).filter((dossier): dossier is CompanyDossier => dossier !== null);

	let acted = 0;
	for (const broker of brokers) {
		const rng = seededRng('broker', broker.key, dayIndex);
		const temperament = temperamentOf(broker);

		if (rng() < temperament.engagementChance) {
			// Selling first only lists, so it cannot eat the buying budget — and it puts this
			// desk's asks on the book before the desks after it decide what to buy.
			await sellPass(broker, dossiers, rng, temperament);
			await buyPass(broker, dossiers, rng, temperament);
		}

		await db.brokers.update(broker.id, { lastBrokerDay: dayIndex });
		acted += 1;
	}

	return acted;
};
