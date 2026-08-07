import {
	companyValuation,
	fireCeo,
	moveShares,
	refreshControl,
	sharesHeldBy
} from '$db/repo';
import {
	CONTROL_THRESHOLD,
	PLAYER_HOLDER_ID,
	brokerHolderId,
	db,
	type Broker
} from '$db/schema';
import { gameNow } from './clock';

/**
 * Which desk takes today's fee. Ranked by how little of this airline the desk already holds,
 * then by id: deterministic without needing a seeded stream, spreads the fee across the desks,
 * and can only ever pick one with room under the same cap `fillListingAsBroker` enforces.
 *
 * That cap matters here because `moveShares` sits below the check and would breach it silently.
 * If flavour ever wants a random desk instead, it has to be `seededRng('ceo', …)` — never
 * `Math.random`, which would break the desks' two-world determinism test.
 */
const deskWithRoom = async (companyId: number): Promise<Broker | null> => {
	const desks = await db.brokers.toArray();
	const positions = await Promise.all(
		desks.map(async (desk) => ({
			desk,
			held: await sharesHeldBy(companyId, brokerHolderId(desk.id))
		}))
	);

	const eligible = positions
		.filter((position) => position.held < CONTROL_THRESHOLD)
		.sort((left, right) => left.held - right.held || left.desk.id - right.desk.id);

	return eligible[0]?.desk ?? null;
};

/**
 * A day's fee for every airline run by a hired chief executive: one of the player's shares,
 * sold to a broker desk on the spot. Guarded by `lastCeoDay`, so a thirty-day catch-up costs
 * thirty shares and never charges one day twice.
 *
 * Runs after the carriers have taken their turns, so a CEO is paid for a day they actually ran
 * the airline, and before the desks trade, because their buying room is sized from a snapshot
 * taken at the top of their turn.
 */
export const runCeoDay = async (dayIndex: number): Promise<number> => {
	const employers = (await db.companies.toArray()).filter((company) => company.ceoHired ?? false);
	let paid = 0;

	for (const stale of employers) {
		if ((stale.lastCeoDay ?? 0) >= dayIndex) continue;

		// Re-read: an earlier airline's fee can dismiss this one's CEO, because paying it
		// settles through `refreshControl`.
		const company = await db.companies.get(stale.id);
		if (!company || !(company.ceoHired ?? false)) continue;
		if ((company.lastCeoDay ?? 0) >= dayIndex) continue;

		const held = await sharesHeldBy(company.id, PLAYER_HOLDER_ID);
		const desk = await deskWithRoom(company.id);
		if (held < 1 || desk === null) {
			// Nothing to pay with, or nowhere to sell it: an unpaid chief executive walks.
			await fireCeo(company.id);
			continue;
		}

		// Always the player to a desk, always exactly one share. `moveShares` mints shares
		// when told to move them to their own holder and can change the register total on a
		// negative quantity, and neither is guarded there — only the register invariants in
		// the tests would catch it.
		await moveShares(company.id, PLAYER_HOLDER_ID, brokerHolderId(desk.id), 1);

		// The only audit trail in the schema for a share changing hands. `pricePerShare` is
		// what the fee was notionally worth, not a sum the player received — there is no cash
		// leg at all.
		const { sharePrice } = await companyValuation(company.id);
		await db.share_trades.add({
			companyId: company.id,
			at: gameNow(),
			buyerId: brokerHolderId(desk.id),
			sellerId: PLAYER_HOLDER_ID,
			quantity: 1,
			pricePerShare: sharePrice
		});

		await db.companies.update(company.id, { lastCeoDay: dayIndex });

		// The fee may have cost the player their majority, which dismisses the CEO in the same
		// write that hands the airline back to its own management.
		await refreshControl(company.id);
		paid += 1;
	}

	return paid;
};
