import 'fake-indexeddb/auto';
import { db } from '$db/schema';
import { seedWorld } from '$db/seed';
import { setClockOffset } from '$engine/clock';

/**
 * Rebuilds the world in a throwaway IndexedDB so tests can drive the real
 * simulation — same schema, same seed, same engine as the browser.
 */
export const freshWorld = async (): Promise<void> => {
	setClockOffset(0);
	if (db.isOpen()) db.close();
	await db.delete();
	await db.open();
	await seedWorld();
};

/**
 * Cash for fixture airlines. Deliberately far above STARTING_CASH: a scenario
 * that needs a widebody, a long-range freighter or a second airframe is about
 * the engine, not about opening-day affordability, so it must not break every
 * time the opening balance is retuned.
 */
export const FIXTURE_CASH = 2_000_000_000;

/** Advances the world clock by `hours` without replaying anything already simulated. */
export const advanceHours = async (hours: number): Promise<void> => {
	const { getClockOffset } = await import('$engine/clock');
	const { catchUp } = await import('$engine/tick');

	setClockOffset(getClockOffset() + hours * 3_600_000);
	await catchUp();
};

/**
 * Gives the carriers `count` days of decisions with the clock standing still, for tests that
 * assert on what an airline decided rather than on what it flew. Moving the clock instead
 * would replay every scheduled departure in the world to reach the same decisions, which is
 * the single most expensive thing the suite can do.
 */
export const runAiDays = async (count: number): Promise<void> => {
	const { dayIndexOf, gameNow } = await import('$engine/clock');
	const { runAiDay } = await import('$engine/ai');

	const today = dayIndexOf(gameNow());
	for (let offset = 1; offset <= count; offset += 1) {
		await runAiDay(today + offset);
	}
};

/** The same, for the broker desks. */
export const runBrokerDays = async (count: number): Promise<void> => {
	const { dayIndexOf, gameNow } = await import('$engine/clock');
	const { runBrokerDay } = await import('$engine/broker');

	const today = dayIndexOf(gameNow());
	for (let offset = 1; offset <= count; offset += 1) {
		await runBrokerDay(today + offset);
	}
};

/** The same, for takeover offers: a night of the board defending, then resolution when due. */
export const runBidDays = async (count: number): Promise<void> => {
	const { dayIndexOf, gameNow } = await import('$engine/clock');
	const { runBidDay } = await import('$engine/takeover');

	const today = dayIndexOf(gameNow());
	for (let offset = 1; offset <= count; offset += 1) {
		await runBidDay(today + offset);
	}
};

/** The same, for the chief executives' daily fee. */
export const runCeoDays = async (count: number): Promise<void> => {
	const { dayIndexOf, gameNow } = await import('$engine/clock');
	const { runCeoDay } = await import('$engine/ceo');

	const today = dayIndexOf(gameNow());
	for (let offset = 1; offset <= count; offset += 1) {
		await runCeoDay(today + offset);
	}
};
