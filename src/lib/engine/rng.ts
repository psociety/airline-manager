/** Deterministic 32-bit string hash (FNV-1a style), used to seed per-entity RNGs. */
export const hashString = (value: string): number => {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
};

export type Rng = () => number;

/** Small, fast, seedable PRNG. Same seed always yields the same sequence. */
export const mulberry32 = (seed: number): Rng => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let result = Math.imul(state ^ (state >>> 15), 1 | state);
		result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
		return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
	};
};

export const seededRng = (...parts: (string | number)[]): Rng =>
	mulberry32(hashString(parts.join(':')));

export const randomBetween = (rng: Rng, min: number, max: number): number =>
	min + rng() * (max - min);

export const randomIntBetween = (rng: Rng, min: number, max: number): number =>
	Math.floor(randomBetween(rng, min, max + 1));

export const pickOne = <T>(rng: Rng, items: readonly T[]): T =>
	items[Math.min(items.length - 1, Math.floor(rng() * items.length))];

export const chance = (rng: Rng, probability: number): boolean => rng() < probability;

/** Unseeded helpers for player-facing one-off rolls. */
export const liveRandomBetween = (min: number, max: number): number =>
	min + Math.random() * (max - min);

export const liveRandomIntBetween = (min: number, max: number): number =>
	Math.floor(liveRandomBetween(min, max + 1));
