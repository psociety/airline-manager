import gateData from './airport_gates.json';
import { AIRPORTS, findAirport, getAirport } from './airports';
import type { Airport, GateBlueprint } from './types';

const GATE_COUNTS = (gateData as { gateCounts: Record<string, number> }).gateCounts;

/** Gate ratings in use. A gate rated N accepts every aircraft of category <= N. */
export const GATE_RATINGS = [2, 4, 6, 8, 10] as const;

/** Share of an airport's stands per rating, before the runway cap is applied. */
const RATING_SHARE: Record<number, number> = { 2: 0.14, 4: 0.16, 6: 0.4, 8: 0.22, 10: 0.08 };

const TERMINAL_LETTERS = 'ABCDEFGHJKLM';
const GATES_PER_TERMINAL = 24;

export const gateCountFor = (iataCode: string): number => GATE_COUNTS[iataCode] ?? 8;

/** The heaviest category an airport's runway can take. */
export const maxCategoryForAirport = (airport: Pick<Airport, 'runwayLength'>): number => {
	if (airport.runwayLength >= 3600) return 10;
	if (airport.runwayLength >= 3200) return 8;
	if (airport.runwayLength >= 2600) return 6;
	if (airport.runwayLength >= 2000) return 4;
	return 2;
};

/** What a stand's rating is worth: a category 10 pier is not a category 2 apron. */
const categoryWeight = (maxCategory: number): number => 0.55 + 0.095 * maxCategory;

export const gatePrice = (tier: number, maxCategory: number): number => {
	const base = 300_000 + tier * tier * 95_000;
	return Math.round((base * categoryWeight(maxCategory)) / 5_000) * 5_000;
};

/** The largest stand a field can offer, and the one that pays the published fees. */
const TOP_RATING = GATE_RATINGS[GATE_RATINGS.length - 1];

/**
 * How much of an airport's fee schedule a departure from this stand attracts. The
 * heaviest stands carry the jetways, the de-icing rigs and the load-bearing apron the
 * published fees are written for; a small stand is a fraction of that airport. Scaled
 * against the top rating so the published fees stay the ceiling.
 */
export const gateFeeFactor = (maxCategory: number): number =>
	categoryWeight(maxCategory) / categoryWeight(TOP_RATING);

/**
 * The stand to take for a given aircraft category: the smallest rating that still
 * accepts it. Anything larger is paid for twice — once to buy, then on every pushback,
 * since departure fees scale with the rating. Null when nothing on offer is big enough.
 */
export const smallestGateForCategory = <T extends { maxCategory: number }>(
	gates: T[],
	requiredCategory: number
): T | null =>
	gates
		.filter((gate) => gate.maxCategory >= requiredCategory)
		.reduce<T | null>(
			(smallest, gate) =>
				smallest === null || gate.maxCategory < smallest.maxCategory ? gate : smallest,
			null
		);

/** Stable identity for a stand: its airport and its number, e.g. `ATL-A1`. */
export const gateKey = (iataCode: string, number: string): string => `${iataCode}-${number}`;

/** Splits a gate key back into its parts, or null when it does not name a real stand. */
export const parseGateKey = (key: string): { airportIata: string; number: string } | null => {
	const separator = key.indexOf('-');
	if (separator < 1) return null;

	return { airportIata: key.slice(0, separator), number: key.slice(separator + 1) };
};

/**
 * Deterministic stand list for an airport: real-world gate count from the curated
 * table, ratings spread over the usable categories, realistic terminal labels.
 */
const buildGatesForAirport = (iataCode: string): GateBlueprint[] => {
	const airport = getAirport(iataCode);
	const total = gateCountFor(iataCode);
	const cap = maxCategoryForAirport(airport);
	const usableRatings = GATE_RATINGS.filter((rating) => rating <= cap);

	const shareTotal = usableRatings.reduce((sum, rating) => sum + RATING_SHARE[rating], 0);
	const counts = new Map<number, number>();
	let assigned = 0;

	for (const rating of usableRatings) {
		const count = Math.floor((total * RATING_SHARE[rating]) / shareTotal);
		counts.set(rating, count);
		assigned += count;
	}

	// Remainder goes to the heaviest rating the airport can handle, so every
	// airport keeps at least one stand for its largest permitted aircraft.
	const topRating = usableRatings[usableRatings.length - 1];
	counts.set(topRating, (counts.get(topRating) ?? 0) + (total - assigned));

	const ratingQueue: number[] = [];
	for (const rating of usableRatings) {
		for (let index = 0; index < (counts.get(rating) ?? 0); index += 1) ratingQueue.push(rating);
	}

	// Interleave ratings across terminals so no single terminal is all-widebody.
	ratingQueue.sort((left, right) => left - right);
	const interleaved: number[] = [];
	const stride = Math.max(1, Math.round(ratingQueue.length / GATES_PER_TERMINAL));
	for (let offset = 0; offset < stride; offset += 1) {
		for (let index = offset; index < ratingQueue.length; index += stride) {
			interleaved.push(ratingQueue[index]);
		}
	}

	return interleaved.map((maxCategory, index) => {
		const terminalIndex = Math.floor(index / GATES_PER_TERMINAL);
		const letter = TERMINAL_LETTERS[terminalIndex % TERMINAL_LETTERS.length];
		const number = `${letter}${(index % GATES_PER_TERMINAL) + 1}`;
		return {
			key: gateKey(iataCode, number),
			airportIata: iataCode,
			number,
			maxCategory,
			price: gatePrice(airport.tier, maxCategory)
		};
	});
};

/**
 * Stands are derived on demand and cached: with three hundred airports there is no
 * reason to build fifteen thousand of them when a screen only ever shows one airport.
 */
const gateCache = new Map<string, GateBlueprint[]>();

export const gatesForAirport = (iataCode: string): GateBlueprint[] => {
	const cached = gateCache.get(iataCode);
	if (cached) return cached;

	const built = buildGatesForAirport(iataCode);
	gateCache.set(iataCode, built);
	return built;
};

/** The single stand a key names, or null when the key does not match the dataset. */
export const gateBlueprint = (key: string): GateBlueprint | null => {
	const parsed = parseGateKey(key);
	if (!parsed) return null;
	if (!findAirport(parsed.airportIata)) return null;

	return gatesForAirport(parsed.airportIata).find((gate) => gate.number === parsed.number) ?? null;
};

export const allGateBlueprints = (): GateBlueprint[] =>
	AIRPORTS.flatMap((airport) => gatesForAirport(airport.iataCode));

/**
 * Every stand in the world. Derived from the curated counts so that adding airports
 * does not require touching assertions scattered across the suite — one canary test
 * pins this number, and everything else compares against it.
 */
export const TOTAL_GATE_COUNT = AIRPORTS.reduce(
	(sum, airport) => sum + gateCountFor(airport.iataCode),
	0
);
