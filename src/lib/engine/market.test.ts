import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_CASH, advanceHours, freshWorld, runAiDays } from './testing/world';
import { AIRCRAFT_MODELS, defaultSeatConfig } from '$data/aircraft';
import {
	acquireAircraft,
	buyListedShares,
	cancelListing,
	companyGates,
	companyValuation,
	createCompany,
	fillListingAsBroker,
	listSharesForSale,
	openTakeoverBid,
	postTransaction,
	sharesHeldBy,
	transactionsBetweenDays
} from '$db/repo';
import {
	CONTROL_THRESHOLD,
	PLAYER_HOLDER_ID,
	TOTAL_SHARES,
	brokerHolderId,
	companyHolderId,
	db,
	type Company,
	type ShareListing
} from '$db/schema';
import { dayIndexOf, gameNow, startOfDay } from './clock';
import { companyDossier, fillOrder, premiumToBook, sharesForControl } from './market';

const foundAirline = async (): Promise<Company> =>
	createCompany({ name: 'Holding Air', icao: 'HLD', homeIata: 'BCN' });

const ask = (
	id: number,
	quantity: number,
	pricePerShare: number,
	sellerId = 'c:99'
): Pick<ShareListing, 'id' | 'quantity' | 'pricePerShare' | 'sellerId'> => ({
	id,
	quantity,
	pricePerShare,
	sellerId
});

const anyAiCompany = async (): Promise<Company> => {
	const companies = await db.companies.where('controller').equals('ai').toArray();
	return companies[0];
};

describe('share market', () => {
	beforeEach(async () => {
		await freshWorld();
	});

	describe('WHEN an airline lists part of its float', () => {
		it('should transfer shares and cash to the buyer and seller', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();
			const sellerId = companyHolderId(target.id);

			await listSharesForSale(target.id, sellerId, 100, 5_000);
			const listing = (await db.share_listings.where('companyId').equals(target.id).toArray())[0];

			const buyerCashBefore = player.cash;
			const sellerCashBefore = (await db.companies.get(target.id))!.cash;

			await buyListedShares(listing.id, PLAYER_HOLDER_ID, player.id, 40);

			const buyerCashAfter = (await db.companies.get(player.id))!.cash;
			const sellerCashAfter = (await db.companies.get(target.id))!.cash;

			expect(await sharesHeldBy(target.id, PLAYER_HOLDER_ID)).toBe(40);
			expect(await sharesHeldBy(target.id, sellerId)).toBe(TOTAL_SHARES - 40);
			expect(buyerCashAfter).toBe(buyerCashBefore - 40 * 5_000);
			expect(sellerCashAfter).toBe(sellerCashBefore + 40 * 5_000);
		});

		it('should keep the register at exactly three thousand shares', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();
			const sellerId = companyHolderId(target.id);

			await listSharesForSale(target.id, sellerId, 500, 1_000);
			const listing = (await db.share_listings.where('companyId').equals(target.id).toArray())[0];
			await buyListedShares(listing.id, PLAYER_HOLDER_ID, player.id, 500);

			const holdings = await db.shareholdings.where('companyId').equals(target.id).toArray();
			const total = holdings.reduce((sum, holding) => sum + holding.quantity, 0);

			expect(total).toBe(TOTAL_SHARES);
		});

		it('should leave the remainder on the market for a partial fill', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();

			await listSharesForSale(target.id, companyHolderId(target.id), 100, 1_000);
			const listing = (await db.share_listings.where('companyId').equals(target.id).toArray())[0];

			await buyListedShares(listing.id, PLAYER_HOLDER_ID, player.id, 30);

			const remaining = await db.share_listings.get(listing.id);
			expect(remaining!.quantity).toBe(70);
		});

		it('should refuse to list shares the seller does not hold', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();

			await expect(
				listSharesForSale(target.id, PLAYER_HOLDER_ID, 10, 1_000)
			).rejects.toThrow('Not enough unlisted shares');

			await expect(
				listSharesForSale(player.id, PLAYER_HOLDER_ID, TOTAL_SHARES + 1, 1_000)
			).rejects.toThrow('Not enough unlisted shares');
		});

		it('should refuse to double-list the same shares', async () => {
			const player = await foundAirline();

			await listSharesForSale(player.id, PLAYER_HOLDER_ID, 2_000, 1_000);

			await expect(
				listSharesForSale(player.id, PLAYER_HOLDER_ID, 1_500, 1_000)
			).rejects.toThrow('Not enough unlisted shares');
		});

		it('should free the shares again when a listing is withdrawn', async () => {
			const player = await foundAirline();
			await listSharesForSale(player.id, PLAYER_HOLDER_ID, 2_000, 1_000);
			const listing = (await db.share_listings.where('companyId').equals(player.id).toArray())[0];

			await cancelListing(listing.id);

			await expect(
				listSharesForSale(player.id, PLAYER_HOLDER_ID, 2_500, 1_000)
			).resolves.toBeUndefined();
		});
	});

	describe('WHEN a holding passes fifty percent', () => {
		it('should hand control of the airline to the player and stop its AI', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();
			const controlling = CONTROL_THRESHOLD + 1;

			await db.companies.update(player.id, { cash: 5_000_000_000 });
			await listSharesForSale(target.id, companyHolderId(target.id), controlling, 1_000);
			const listing = (await db.share_listings.where('companyId').equals(target.id).toArray())[0];

			await buyListedShares(listing.id, PLAYER_HOLDER_ID, player.id, controlling);

			const controlled = await db.companies.get(target.id);
			expect(controlled!.controller).toBe('player');

			// Offered the turns directly rather than through the clock: the point is that
			// `runAiDay` passes over a carrier the player controls, not that time passed. That
			// only holds while nobody has hired a chief executive to run it for them.
			expect(controlled!.ceoHired ?? false).toBe(false);
			const lastAiDayBefore = controlled!.lastAiDay;
			await runAiDays(2);

			const afterDays = await db.companies.get(target.id);
			expect(afterDays!.controller).toBe('player');
			expect(afterDays!.lastAiDay).toBe(lastAiDayBefore);
		});

		it('should leave control alone below the threshold', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();

			await db.companies.update(player.id, { cash: 5_000_000_000 });
			await listSharesForSale(target.id, companyHolderId(target.id), CONTROL_THRESHOLD, 1_000);
			const listing = (await db.share_listings.where('companyId').equals(target.id).toArray())[0];

			await buyListedShares(listing.id, PLAYER_HOLDER_ID, player.id, CONTROL_THRESHOLD);

			const stillAi = await db.companies.get(target.id);
			expect(stillAi!.controller).toBe('ai');
		});
	});

	describe('WHEN an airline is valued', () => {
		it('should price the shares off its assets', async () => {
			const player = await foundAirline();

			const valuation = await companyValuation(player.id);

			// Cash plus one free gate, spread over three thousand shares.
			expect(valuation.assets).toBeGreaterThan(player.cash);
			expect(valuation.sharePrice).toBeGreaterThan(Math.floor(player.cash / TOTAL_SHARES));
		});
	});

	describe('WHEN a rival is put under the microscope', () => {
		const addAircraft = async (
			company: Company,
			ownership: 'owned' | 'leased'
		): Promise<void> => {
			const [gate] = await companyGates(company.id);
			const model = AIRCRAFT_MODELS.find(
				(candidate) => candidate.category <= gate.maxCategory && candidate.seats > 40
			);
			if (!model) throw new Error('no suitable model for the test');

			await acquireAircraft({
				companyId: company.id,
				modelId: model.id,
				name: `${company.icao} bird`,
				seats: defaultSeatConfig(model),
				ownership,
				homeGateId: gate.key
			});
		};

		it('should find nothing behind an id that names no airline', async () => {
			expect(await companyDossier(999_999)).toBeNull();
			expect(await companyDossier(Number.NaN)).toBeNull();
		});

		it('should value the airline exactly as the market screen does', async () => {
			const target = await anyAiCompany();

			const dossier = await companyDossier(target.id);
			const valuation = await companyValuation(target.id);

			expect(dossier!.valuation).toEqual(valuation);
			expect(dossier!.assets.total).toBe(valuation.assets);
		});

		it('should count owned and leased airframes apart', async () => {
			const player = await createCompany({
				name: 'Mixed Air',
				icao: 'MIX',
				homeIata: 'MAD',
				cash: FIXTURE_CASH
			});
			await addAircraft(player, 'owned');
			await addAircraft(player, 'leased');

			const dossier = await companyDossier(player.id);

			expect(dossier!.assets.ownedAircraft).toBe(1);
			expect(dossier!.assets.leasedAircraft).toBe(1);
		});

		it('should surface the daily lease bill the balance sheet leaves out', async () => {
			const player = await createCompany({
				name: 'Lease Air',
				icao: 'LSE',
				homeIata: 'LHR',
				cash: FIXTURE_CASH
			});
			await addAircraft(player, 'leased');

			const dossier = await companyDossier(player.id);

			expect(dossier!.assets.fleetBookValue).toBe(0);
			expect(dossier!.dailyLeases).toBeGreaterThan(0);
			expect(dossier!.annualisedLeaseExposure).toBeGreaterThan(dossier!.dailyLeases);
		});

		it('should size the cash runway off wages and leases together', async () => {
			const target = await anyAiCompany();

			const dossier = await companyDossier(target.id);

			expect(dossier!.dailyFixedCosts).toBe(dossier!.dailyWages + dossier!.dailyLeases);
			expect(dossier!.cashRunwayDays).toBeGreaterThan(0);
		});

		it('should list the cheapest ask first and name the treasury behind it', async () => {
			const target = await anyAiCompany();
			const sellerId = companyHolderId(target.id);

			await listSharesForSale(target.id, sellerId, 100, 9_000);
			await listSharesForSale(target.id, sellerId, 100, 4_000);

			const dossier = await companyDossier(target.id);

			expect(dossier!.listings.map((listing) => listing.pricePerShare)).toEqual([4_000, 9_000]);
			expect(dossier!.cheapestAsk).toBe(4_000);
			expect(dossier!.sharesForSale).toBe(200);
			expect(dossier!.listings[0].isTreasury).toBe(true);
		});

		it('should report the buyer’s own stake off the register', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();

			await listSharesForSale(target.id, companyHolderId(target.id), 60, 1_000);
			const listing = (await db.share_listings.where('companyId').equals(target.id).toArray())[0];
			await buyListedShares(listing.id, PLAYER_HOLDER_ID, player.id, 60);

			const dossier = await companyDossier(target.id);

			expect(dossier!.viewerShares).toBe(60);
			expect(dossier!.register.some((holder) => holder.isViewer)).toBe(true);
			expect(dossier!.register.reduce((sum, holder) => sum + holder.quantity, 0)).toBe(
				TOTAL_SHARES
			);
		});

		it('should price a controlling stake against the book on offer', async () => {
			const target = await anyAiCompany();
			const controlling = CONTROL_THRESHOLD + 1;

			await listSharesForSale(target.id, companyHolderId(target.id), controlling, 2_000);

			const dossier = await companyDossier(target.id);

			expect(dossier!.control.sharesNeeded).toBe(controlling);
			expect(dossier!.control.attainable).toBe(true);
			expect(dossier!.control.plan.total).toBe(controlling * 2_000);
		});

		it('should refuse to quote control the book cannot supply', async () => {
			const target = await anyAiCompany();

			await listSharesForSale(target.id, companyHolderId(target.id), 100, 2_000);

			const dossier = await companyDossier(target.id);

			expect(dossier!.control.attainable).toBe(false);
			expect(dossier!.control.plan.shortfall).toBeGreaterThan(0);
		});

		it('should count an unsettled accident as a liability', async () => {
			const target = await anyAiCompany();
			const fleet = await db.aircraft.where('companyId').equals(target.id).toArray();

			await db.incidents.add({
				companyId: target.id,
				aircraftId: fleet[0].id!,
				aircraftName: fleet[0].name,
				flightId: null,
				at: Date.now(),
				passengers: 90,
				baseAmount: 3_000_000,
				status: 'pending',
				outcome: null,
				finalAmount: null,
				resolvedAt: null
			});

			const dossier = await companyDossier(target.id);

			expect(dossier!.pendingIncidentCount).toBe(1);
			expect(dossier!.pendingIncidentExposure).toBe(3_000_000);
		});

		it('should leave ledger rows older than the window out of the account', async () => {
			const target = await anyAiCompany();

			await db.transaction_records.add({
				companyId: target.id,
				at: 0,
				day: 1,
				direction: 'income',
				category: 'ticket_sales',
				amount: 999_000_000,
				description: 'Ancient history',
				refId: null
			});

			const dossier = await companyDossier(target.id);

			expect(dossier!.pnl.operatingRevenue).toBeLessThan(999_000_000);
		});

		it('should charge a closed day’s wages against the operating result', async () => {
			const target = await anyAiCompany();
			// A wage row inside the window, posted where a closed day would have put it,
			// rather than three simulated days of the whole world to produce the same row.
			await postTransaction(target.id, 'wages', -120_000, 'Daily wages — test', {
				at: startOfDay(dayIndexOf(gameNow()) - 1),
				allowOverdraft: true
			});

			const dossier = await companyDossier(target.id);

			expect(dossier!.pnl.operatingCost).toBeLessThan(0);
			expect(dossier!.pnl.entryCount).toBeGreaterThan(0);
		});

		it('should hold every figure finite for a freshly founded airline', async () => {
			const player = await foundAirline();

			const dossier = await companyDossier(player.id);

			expect(dossier!.pnl.daysCovered).toBeGreaterThanOrEqual(1);
			expect(Number.isFinite(dossier!.pnl.dailyOperatingResult)).toBe(true);
			expect(Number.isFinite(dossier!.bookValuePerShare)).toBe(true);
			expect(dossier!.cheapestAsk).toBeNull();
			expect(dossier!.askPremiumToBook).toBeNull();
			expect(dossier!.quotePremiumToBook).not.toBeNaN();
		});

		it('should report no offer and no lock-out on an airline nobody has bid for', async () => {
			const target = await anyAiCompany();

			const dossier = await companyDossier(target.id);

			expect(dossier!.openBid).toBeNull();
			expect(dossier!.bidLockoutUntilDay).toBeNull();
		});

		it('should surface the offer standing against the airline', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();
			await db.companies.update(player.id, { cash: 500_000_000 });
			await openTakeoverBid({
				targetCompanyId: target.id,
				bidderHolderId: PLAYER_HOLDER_ID,
				bidderCompanyId: player.id,
				pricePerShare: 9_000,
				sharesSought: 1_501,
				closesDay: 42
			});

			const dossier = await companyDossier(target.id);

			expect(dossier!.openBid?.pricePerShare).toBe(9_000);
			expect(dossier!.openBid?.closesDay).toBe(42);
		});
	});

	describe('WHEN a broker desk fills an ask', () => {
		const deskHolder = async (): Promise<string> => {
			const desk = (await db.brokers.toArray())[0];
			return brokerHolderId(desk.id);
		};

		const floatShares = async (
			target: Company,
			quantity: number,
			pricePerShare: number
		): Promise<number> => {
			await listSharesForSale(target.id, companyHolderId(target.id), quantity, pricePerShare);
			const listings = await db.share_listings.where('companyId').equals(target.id).toArray();
			return listings[listings.length - 1].id;
		};

		it('should pay the airline that floated the shares', async () => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, 100, 4_000);
			const cashBefore = (await db.companies.get(target.id))!.cash;

			await fillListingAsBroker(listingId, await deskHolder(), 100);

			const cashAfter = (await db.companies.get(target.id))!.cash;
			const sales = await db.transaction_records.where('category').equals('share_sale').toArray();

			expect(cashAfter).toBe(cashBefore + 100 * 4_000);
			expect(sales).toHaveLength(1);
		});

		it('should charge nobody, because a desk has no balance sheet', async () => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, 50, 3_000);
			const before = (await db.companies.toArray()).reduce(
				(sum, company) => sum + company.cash,
				0
			);

			await fillListingAsBroker(listingId, await deskHolder(), 50);

			const after = (await db.companies.toArray()).reduce((sum, company) => sum + company.cash, 0);
			const purchases = await db.transaction_records
				.where('category')
				.equals('share_purchase')
				.toArray();

			expect(after).toBe(before + 50 * 3_000);
			expect(purchases).toHaveLength(0);
		});

		it('should move the shares without minting any', async () => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, 120, 2_000);
			const holderId = await deskHolder();

			await fillListingAsBroker(listingId, holderId, 120);

			const holdings = await db.shareholdings.where('companyId').equals(target.id).toArray();

			expect(await sharesHeldBy(target.id, holderId)).toBe(120);
			expect(holdings.reduce((sum, holding) => sum + holding.quantity, 0)).toBe(TOTAL_SHARES);
		});

		it('should record the trade against the desk', async () => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, 40, 5_000);
			const holderId = await deskHolder();

			await fillListingAsBroker(listingId, holderId, 40);

			const trades = await db.share_trades.toArray();

			expect(trades).toHaveLength(1);
			expect(trades[0]).toMatchObject({ buyerId: holderId, quantity: 40, pricePerShare: 5_000 });
		});

		it('should leave the remainder of a part-filled ask on the market', async () => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, 100, 1_500);

			await fillListingAsBroker(listingId, await deskHolder(), 30);

			expect((await db.share_listings.get(listingId))!.quantity).toBe(70);
		});

		it.each`
			quantity | reason
			${0}     | ${'nothing was asked for'}
			${-5}    | ${'the quantity was negative'}
			${101}   | ${'the ask is not that big'}
		`('should refuse a fill when $reason', async ({ quantity }) => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, 100, 1_000);

			await expect(fillListingAsBroker(listingId, await deskHolder(), quantity)).rejects.toThrow(
				'Invalid quantity'
			);
		});

		it('should refuse a holder id that names no desk', async () => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, 100, 1_000);

			await expect(fillListingAsBroker(listingId, PLAYER_HOLDER_ID, 10)).rejects.toThrow(
				'Not a broker'
			);
		});

		it('should refuse to buy back its own ask', async () => {
			const target = await anyAiCompany();
			const holderId = await deskHolder();
			await floatShares(target, 200, 1_000);
			const treasuryListing = (
				await db.share_listings.where('companyId').equals(target.id).toArray()
			)[0];
			await fillListingAsBroker(treasuryListing.id, holderId, 200);
			await listSharesForSale(target.id, holderId, 100, 2_000);
			const own = (await db.share_listings.where('companyId').equals(target.id).toArray())[0];

			await expect(fillListingAsBroker(own.id, holderId, 50)).rejects.toThrow(
				'You already own those shares'
			);
		});

		it('should stop at half the float rather than take control', async () => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, CONTROL_THRESHOLD + 1, 1_000);

			await expect(
				fillListingAsBroker(listingId, await deskHolder(), CONTROL_THRESHOLD + 1)
			).rejects.toThrow('Broker holding cap reached');
		});

		it('should allow a fill that lands exactly on half the float', async () => {
			const target = await anyAiCompany();
			const listingId = await floatShares(target, CONTROL_THRESHOLD, 1_000);
			const holderId = await deskHolder();

			await fillListingAsBroker(listingId, holderId, CONTROL_THRESHOLD);

			expect(await sharesHeldBy(target.id, holderId)).toBe(CONTROL_THRESHOLD);
			expect((await db.companies.get(target.id))!.controller).toBe('ai');
		});

		it('should pay the player when a desk buys the stake they listed', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();
			await listSharesForSale(target.id, companyHolderId(target.id), 80, 1_000);
			const treasuryListing = (
				await db.share_listings.where('companyId').equals(target.id).toArray()
			)[0];
			await buyListedShares(treasuryListing.id, PLAYER_HOLDER_ID, player.id, 80);

			await listSharesForSale(target.id, PLAYER_HOLDER_ID, 80, 9_000, player.id);
			const playerListing = (
				await db.share_listings.where('companyId').equals(target.id).toArray()
			)[0];
			const cashBefore = (await db.companies.get(player.id))!.cash;

			await fillListingAsBroker(playerListing.id, await deskHolder(), 80);

			expect((await db.companies.get(player.id))!.cash).toBe(cashBefore + 80 * 9_000);
		});

		it('should settle a listing made before proceeds were recorded, paying nobody', async () => {
			const player = await foundAirline();
			const target = await anyAiCompany();
			await listSharesForSale(target.id, companyHolderId(target.id), 60, 1_000);
			const treasuryListing = (
				await db.share_listings.where('companyId').equals(target.id).toArray()
			)[0];
			await buyListedShares(treasuryListing.id, PLAYER_HOLDER_ID, player.id, 60);

			// A listing from a save written before `proceedsCompanyId` existed.
			await listSharesForSale(target.id, PLAYER_HOLDER_ID, 60, 7_000);
			const legacy = (await db.share_listings.where('companyId').equals(target.id).toArray())[0];
			const cashBefore = (await db.companies.get(player.id))!.cash;

			await fillListingAsBroker(legacy.id, await deskHolder(), 60);

			expect((await db.companies.get(player.id))!.cash).toBe(cashBefore);
			expect(await sharesHeldBy(target.id, PLAYER_HOLDER_ID)).toBe(0);
		});
	});

	describe('WHEN reading a span of ledger days', () => {
		it('should include both ends and stop at the day after', async () => {
			const player = await foundAirline();
			const rows = [5, 6, 7, 8].map((day) => ({
				companyId: player.id,
				at: day * 1_000,
				day,
				direction: 'expense' as const,
				category: 'fuel' as const,
				amount: -100,
				description: `Day ${day}`,
				refId: null
			}));
			await db.transaction_records.bulkAdd(rows);

			const result = await transactionsBetweenDays(player.id, 5, 7);

			expect(result.map((record) => record.day).sort()).toEqual([5, 6, 7]);
		});
	});
});

describe('share order book', () => {
	describe('WHEN planning an order', () => {
		it('should take the cheapest asks first', () => {
			const result = fillOrder([ask(1, 10, 900), ask(2, 10, 300), ask(3, 10, 600)], 25);

			expect(result.fills.map((fill) => fill.pricePerShare)).toEqual([300, 600, 900]);
			expect(result.total).toBe(10 * 300 + 10 * 600 + 5 * 900);
			expect(result.filled).toBe(25);
			expect(result.shortfall).toBe(0);
		});

		it('should split the last ask when the order stops part way through it', () => {
			const result = fillOrder([ask(1, 100, 500)], 30);

			expect(result.fills).toEqual([{ listingId: 1, quantity: 30, pricePerShare: 500 }]);
			expect(result.total).toBe(15_000);
		});

		it('should report a shortfall when the book is too thin', () => {
			const result = fillOrder([ask(1, 20, 500)], 50);

			expect(result.filled).toBe(20);
			expect(result.shortfall).toBe(30);
			expect(result.total).toBe(10_000);
		});

		it('should skip the buyer’s own asks, which cannot be bought back', () => {
			const result = fillOrder(
				[ask(1, 10, 100, PLAYER_HOLDER_ID), ask(2, 10, 800)],
				10,
				PLAYER_HOLDER_ID
			);

			expect(result.fills).toEqual([{ listingId: 2, quantity: 10, pricePerShare: 800 }]);
			expect(result.total).toBe(8_000);
		});

		it('should average what was actually paid, not the prices on offer', () => {
			const result = fillOrder([ask(1, 90, 100), ask(2, 10, 1_100)], 100);

			expect(result.averagePricePerShare).toBe((90 * 100 + 10 * 1_100) / 100);
			expect(result.averagePricePerShare).not.toBe(600);
		});

		it('should walk a book of single-share asks', () => {
			const asks = [ask(1, 1, 300), ask(2, 1, 100), ask(3, 1, 200)];

			const result = fillOrder(asks, 3);

			expect(result.fills.map((fill) => fill.pricePerShare)).toEqual([100, 200, 300]);
		});

		it.each`
			quantity | reason
			${0}     | ${'nothing was asked for'}
			${-5}    | ${'the quantity was negative'}
		`('should plan nothing when $reason', ({ quantity }) => {
			const result = fillOrder([ask(1, 10, 500)], quantity);

			expect(result).toMatchObject({ filled: 0, total: 0, averagePricePerShare: null });
			expect(result.fills).toEqual([]);
		});

		it('should plan nothing against an empty book', () => {
			const result = fillOrder([], 10);

			expect(result.filled).toBe(0);
			expect(result.shortfall).toBe(10);
			expect(result.averagePricePerShare).toBeNull();
		});

		it('should leave the book it was handed in its original order', () => {
			const asks = [ask(1, 10, 900), ask(2, 10, 300)];

			fillOrder(asks, 15);

			expect(asks.map((entry) => entry.id)).toEqual([1, 2]);
		});
	});

	describe('WHEN counting the shares control needs', () => {
		it.each`
			held    | needed
			${0}    | ${1501}
			${1499} | ${2}
			${1500} | ${1}
			${1501} | ${0}
			${3000} | ${0}
		`('should need $needed more when holding $held', ({ held, needed }) => {
			const result = sharesForControl(held);

			expect(result).toBe(needed);
		});
	});

	describe('WHEN comparing an ask to book value', () => {
		it.each`
			ask      | book    | expected
			${1_200} | ${1000} | ${1.2}
			${800}   | ${1000} | ${0.8}
			${1_000} | ${0}    | ${null}
			${1_000} | ${-500} | ${null}
		`('should read $ask against a book of $book as $expected', ({ ask: price, book, expected }) => {
			const result = premiumToBook(price, book);

			expect(result).toBe(expected);
		});
	});
});
