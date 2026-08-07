import { describe, expect, it } from 'vitest';
import { AIRCRAFT_MODELS, getModel } from '$data/aircraft';
import {
	EXTERNAL_WORKER_DAILY_COST,
	HIRED_WORKER_DAILY_COST,
	HIRING_FEE,
	TOTAL_SHARES
} from '$db/schema';
import {
	FUEL_PRICE_MAX,
	FUEL_PRICE_MIN,
	MIN_SHARE_PRICE,
	ROUTE_GOODWILL,
	aircraftResaleValue,
	airportTaxFor,
	assetBreakdown,
	dailyLeaseBill,
	dailyWageBill,
	driftFuelPrice,
	driftMarketMultiplier,
	formatCompactMoney,
	fuelCostFor,
	hiringCost,
	maintenanceCost,
	ticketRevenue,
	valuation
} from './economy';

const a320 = () => {
	const model = AIRCRAFT_MODELS.find((candidate) => candidate.name === 'A320-200');
	if (!model) throw new Error('missing A320-200');
	return model;
};

describe('economy helpers', () => {
	describe('WHEN billing fuel', () => {
		it('should cost about 3.700 € for an A320 over 1000 km at 0,85 €/L', () => {
			const result = fuelCostFor(a320(), 1000, 0.85);

			expect(result).toBeGreaterThan(3_400);
			expect(result).toBeLessThan(3_900);
		});

		it('should scale linearly with distance, give or take rounding', () => {
			const short = fuelCostFor(a320(), 500, 0.85);
			const long = fuelCostFor(a320(), 1000, 0.85);

			expect(Math.abs(long - short * 2)).toBeLessThanOrEqual(1);
		});

		it('should scale with the fuel price', () => {
			const cheap = fuelCostFor(a320(), 1000, 0.6);
			const dear = fuelCostFor(a320(), 1000, 1.2);

			expect(dear).toBeCloseTo(cheap * 2, 0);
		});
	});

	describe('WHEN charging departure fees', () => {
		const TOP_RATING = 10;

		it('should combine the landing fee with the per-passenger fee', () => {
			const model = a320();

			const empty = airportTaxFor('ATL', model, 0, TOP_RATING);
			const full = airportTaxFor('ATL', model, 100, TOP_RATING);

			// ATL charges 8,5 €/t and 25 €/pax.
			expect(empty).toBe(Math.round(8.5 * model.payload));
			expect(full).toBe(empty + 2_500);
		});

		it('should differ between airports', () => {
			const atlanta = airportTaxFor('ATL', a320(), 100, TOP_RATING);
			const losAngeles = airportTaxFor('LAX', a320(), 100, TOP_RATING);

			expect(losAngeles).not.toBe(atlanta);
		});

		it('should charge the published fees in full at the largest stand', () => {
			const model = a320();

			const top = airportTaxFor('ATL', model, 100, TOP_RATING);

			expect(top).toBe(Math.round(8.5 * model.payload) + 2_500);
		});

		it.each`
			rating | expected
			${2}   | ${0.493}
			${4}   | ${0.62}
			${6}   | ${0.747}
			${8}   | ${0.873}
			${10}  | ${1}
		`('should charge $expected of the schedule from a category $rating stand', ({ rating, expected }) => {
			const model = a320();
			const scheduled = 8.5 * model.payload + 25 * 100;

			const charged = airportTaxFor('ATL', model, 100, rating);

			expect(charged / scheduled).toBeCloseTo(expected, 2);
		});

		it('should never charge more from a smaller stand', () => {
			const model = a320();

			const charges = [2, 4, 6, 8, 10].map((rating) =>
				airportTaxFor('ATL', model, 100, rating)
			);

			expect(charges).toEqual([...charges].sort((left, right) => left - right));
		});
	});

	describe('WHEN totalling ticket revenue', () => {
		it('should multiply each cabin by its fare', () => {
			const result = ticketRevenue(
				{ economy: 100, business: 10, first: 2 },
				{ economy: 120, business: 320, first: 600 }
			);

			expect(result).toBe(100 * 120 + 10 * 320 + 2 * 600);
		});
	});

	describe('WHEN paying the workforce', () => {
		it.each`
			external | hired  | expected
			${0}     | ${0}   | ${0}
			${10}    | ${0}   | ${3300}
			${0}     | ${10}  | ${2940}
			${100}   | ${100} | ${62400}
		`(
			'should bill $expected € per day for $external external and $hired hired',
			({ external, hired, expected }) => {
				const result = dailyWageBill({ external_workers: external, hired_workers: hired });

				expect(result).toBe(expected);
			}
		);

		it('should make a hired worker cheaper per day than an external one', () => {
			expect(HIRED_WORKER_DAILY_COST).toBeLessThan(EXTERNAL_WORKER_DAILY_COST);
		});

		it('should charge the hiring fee per head', () => {
			const result = hiringCost(12);

			expect(result).toBe(12 * HIRING_FEE);
		});

		it('should pay back the hiring fee within a month', () => {
			const dailySaving = EXTERNAL_WORKER_DAILY_COST - HIRED_WORKER_DAILY_COST;
			const paybackDays = Math.ceil(HIRING_FEE / dailySaving);

			expect(paybackDays).toBeLessThanOrEqual(31);
		});
	});

	describe('WHEN paying for leases', () => {
		it('should only bill leased airframes', () => {
			const result = dailyLeaseBill([
				{ ownership: 'leased', leaseDailyRate: 50_000 },
				{ ownership: 'owned', leaseDailyRate: 0 },
				{ ownership: 'leased', leaseDailyRate: 25_000 }
			]);

			expect(result).toBe(75_000);
		});
	});

	describe('WHEN invoicing a heavy check', () => {
		it('should charge more for a bigger type', () => {
			const widebody = maintenanceCost(getModel(a320().id).id);
			const regional = AIRCRAFT_MODELS[0];

			expect(widebody).toBeGreaterThan(maintenanceCost(regional.id));
		});

		it('should stay a small fraction of the purchase price', () => {
			const model = a320();

			const result = maintenanceCost(model.id);

			expect(result).toBeLessThan(model.price * 0.02);
		});
	});

	describe('WHEN valuing an airline', () => {
		it('should count cash, fleet, gates and route goodwill', () => {
			const model = a320();

			const result = valuation(
				{
					company: { cash: 100_000_000 },
					fleet: [{ ownership: 'owned', modelId: model.id, totalKm: 0 }],
					gates: [{ price: 5_000_000 }],
					routeCount: 2
				},
				1
			);

			expect(result.assets).toBe(100_000_000 + model.price + 5_000_000 + 2 * ROUTE_GOODWILL);
			expect(result.sharePrice).toBe(Math.round(result.assets / TOTAL_SHARES));
		});

		it('should not count a leased airframe as an asset', () => {
			const model = a320();
			const base = { company: { cash: 1_000_000 }, gates: [], routeCount: 0 };

			const owned = valuation(
				{ ...base, fleet: [{ ownership: 'owned', modelId: model.id, totalKm: 0 }] },
				1
			);
			const leased = valuation(
				{ ...base, fleet: [{ ownership: 'leased', modelId: model.id, totalKm: 0 }] },
				1
			);

			expect(leased.assets).toBeLessThan(owned.assets);
			expect(leased.assets).toBe(1_000_000);
		});

		it('should depreciate a high-time airframe', () => {
			const model = a320();
			const base = { company: { cash: 0 }, gates: [], routeCount: 0 };

			const fresh = valuation(
				{ ...base, fleet: [{ ownership: 'owned', modelId: model.id, totalKm: 0 }] },
				1
			);
			const worn = valuation(
				{ ...base, fleet: [{ ownership: 'owned', modelId: model.id, totalKm: 3_000_000 }] },
				1
			);

			expect(worn.assets).toBeLessThan(fresh.assets);
		});

		it('should never price a share below one hundred euro', () => {
			const result = valuation(
				{ company: { cash: 0 }, fleet: [], gates: [], routeCount: 0 },
				1
			);

			expect(result.sharePrice).toBe(MIN_SHARE_PRICE);
		});
	});

	describe('WHEN breaking an airline’s assets down', () => {
		const inputs = () => {
			const model = a320();
			return {
				company: { cash: 100_000_000 },
				fleet: [
					{ ownership: 'owned' as const, modelId: model.id, totalKm: 0 },
					{ ownership: 'leased' as const, modelId: model.id, totalKm: 0 }
				],
				gates: [{ price: 5_000_000 }, { price: 2_000_000 }],
				routeCount: 3
			};
		};

		it('should total to exactly what the share price is drawn from', () => {
			const shared = inputs();

			const breakdown = assetBreakdown(shared);
			const priced = valuation(shared, 1.4);

			expect(breakdown.total).toBe(priced.assets);
		});

		it('should have its lines add up to the total', () => {
			const breakdown = assetBreakdown(inputs());

			const summed =
				breakdown.cash + breakdown.fleetBookValue + breakdown.gateValue + breakdown.routeGoodwill;

			expect(summed).toBe(breakdown.total);
		});

		it('should credit goodwill per live route', () => {
			const breakdown = assetBreakdown(inputs());

			expect(breakdown.routeGoodwill).toBe(3 * ROUTE_GOODWILL);
		});

		it('should count owned and leased airframes apart', () => {
			const breakdown = assetBreakdown(inputs());

			expect(breakdown.ownedAircraft).toBe(1);
			expect(breakdown.leasedAircraft).toBe(1);
		});

		it('should carry an all-leased fleet at nothing', () => {
			const model = a320();

			const breakdown = assetBreakdown({
				company: { cash: 4_000_000 },
				fleet: [
					{ ownership: 'leased', modelId: model.id, totalKm: 0 },
					{ ownership: 'leased', modelId: model.id, totalKm: 500_000 }
				],
				gates: [],
				routeCount: 0
			});

			expect(breakdown.fleetBookValue).toBe(0);
			expect(breakdown.fleetResaleValue).toBe(0);
			expect(breakdown.total).toBe(4_000_000);
		});

		it('should value a forced sale airframe by airframe', () => {
			const shared = inputs();

			const breakdown = assetBreakdown(shared);
			const summed = shared.fleet.reduce(
				(sum, aircraft) => sum + aircraftResaleValue(aircraft),
				0
			);

			expect(breakdown.fleetResaleValue).toBe(summed);
			expect(breakdown.fleetResaleValue).toBeLessThan(breakdown.fleetBookValue);
		});

		it('should report an overdrawn airline as worth less than nothing', () => {
			const breakdown = assetBreakdown({
				company: { cash: -3_000_000 },
				fleet: [],
				gates: [],
				routeCount: 0
			});

			expect(breakdown.total).toBe(-3_000_000);
		});

		it('should total nothing for an airline that owns nothing', () => {
			const breakdown = assetBreakdown({
				company: { cash: 0 },
				fleet: [],
				gates: [],
				routeCount: 0
			});

			expect(breakdown.total).toBe(0);
		});
	});

	describe('WHEN prices drift overnight', () => {
		it.each`
			roll   | direction
			${0}   | ${'down'}
			${1}   | ${'up'}
		`('should move the fuel price $direction on a roll of $roll', ({ roll, direction }) => {
			const result = driftFuelPrice(0.85, roll);

			if (direction === 'down') expect(result).toBeLessThan(0.85);
			else expect(result).toBeGreaterThan(0.85);
		});

		it('should keep the fuel price inside its band over many days', () => {
			let price = 0.85;
			for (let day = 0; day < 500; day += 1) {
				price = driftFuelPrice(price, (day % 7) / 7);
			}

			expect(price).toBeGreaterThanOrEqual(FUEL_PRICE_MIN);
			expect(price).toBeLessThanOrEqual(FUEL_PRICE_MAX);
		});

		it('should keep market sentiment inside its band over many days', () => {
			let multiplier = 1;
			for (let day = 0; day < 500; day += 1) {
				multiplier = driftMarketMultiplier(multiplier, (day % 5) / 5);
			}

			expect(multiplier).toBeGreaterThanOrEqual(0.6);
			expect(multiplier).toBeLessThanOrEqual(1.8);
		});
	});

	describe('WHEN formatting money for the interface', () => {
		it.each`
			amount           | expected
			${950}           | ${'950 €'}
			${12_500}        | ${'13k €'}
			${2_400_000}     | ${'2.4M €'}
			${1_250_000_000} | ${'1.25B €'}
		`('should render $amount as $expected', ({ amount, expected }) => {
			const result = formatCompactMoney(amount);

			expect(result).toBe(expected);
		});
	});
});
