import { describe, expect, it } from 'vitest';
import { auditCost, workingFares, type RouteIntel } from './audit';
import { routeCargoDemand, routeDemand, vagueRange } from './demand';
import { AUDIT_COST_MAX, AUDIT_COST_MIN } from './economy';

const demand = routeDemand('BCN', 'MAD', 483);

const intel = (audited: boolean): RouteIntel => ({
	pairKey: 'BCN-MAD',
	audited,
	auditCost: 250_000,
	demand,
	cargo: routeCargoDemand('BCN', 'MAD', 483),
	cargoRange: vagueRange(routeCargoDemand('BCN', 'MAD', 483).tonnesPerDay, 'BCN-MAD', 'cargo'),
	vague: {
		demand: {
			economy: vagueRange(demand.dailyDemand.economy, 'BCN-MAD', 'demand-economy'),
			business: vagueRange(demand.dailyDemand.business, 'BCN-MAD', 'demand-business'),
			first: vagueRange(demand.dailyDemand.first, 'BCN-MAD', 'demand-first')
		},
		idealPrice: {
			economy: vagueRange(demand.idealPrice.economy, 'BCN-MAD', 'price-economy'),
			business: vagueRange(demand.idealPrice.business, 'BCN-MAD', 'price-business'),
			first: vagueRange(demand.idealPrice.first, 'BCN-MAD', 'price-first')
		}
	},
	competitors: []
});

describe('audit helpers', () => {
	describe('WHEN quoting an audit', () => {
		it('should stay inside the 30k–1M band for every pair', () => {
			const quotes = ['BCN-MAD', 'JFK-LHR', 'ASU-SAL', 'SIN-SYD'].map((pair) =>
				auditCost(1, pair)
			);

			for (const quote of quotes) {
				expect(quote).toBeGreaterThanOrEqual(AUDIT_COST_MIN);
				expect(quote).toBeLessThanOrEqual(AUDIT_COST_MAX);
			}
		});

		it('should quote the same airline the same price every time', () => {
			expect(auditCost(4, 'BCN-MAD')).toBe(auditCost(4, 'BCN-MAD'));
		});

		it('should quote different airlines independently', () => {
			const quotes = new Set([1, 2, 3, 4, 5].map((companyId) => auditCost(companyId, 'BCN-MAD')));

			expect(quotes.size).toBeGreaterThan(1);
		});
	});

	describe('WHEN an audited route needs fares', () => {
		it('should use the exact ideal fare', () => {
			const result = workingFares(intel(true));

			expect(result).toEqual(demand.idealPrice);
		});
	});

	describe('WHEN an unaudited route needs fares', () => {
		it('should never hand back the exact ideal fare', () => {
			const result = workingFares(intel(false));

			expect(result).not.toEqual(demand.idealPrice);
		});

		it('should sit inside the fuzzed range shown to the player', () => {
			const unaudited = intel(false);

			const result = workingFares(unaudited);

			for (const passengerClass of ['economy', 'business', 'first'] as const) {
				const range = unaudited.vague.idealPrice[passengerClass];
				expect(result[passengerClass]).toBeGreaterThanOrEqual(range.low);
				expect(result[passengerClass]).toBeLessThanOrEqual(range.high);
			}
		});

		it('should stay in the right ballpark so the route is still playable', () => {
			const result = workingFares(intel(false));

			for (const passengerClass of ['economy', 'business', 'first'] as const) {
				const exact = demand.idealPrice[passengerClass];
				expect(result[passengerClass]).toBeGreaterThan(exact * 0.5);
				expect(result[passengerClass]).toBeLessThan(exact * 1.6);
			}
		});

		it('should keep the premium cabins dearer than economy', () => {
			const result = workingFares(intel(false));

			expect(result.business).toBeGreaterThan(result.economy);
			expect(result.first).toBeGreaterThan(result.business);
		});

		it('should be stable, so opening a route twice quotes the same fares', () => {
			expect(workingFares(intel(false))).toEqual(workingFares(intel(false)));
		});
	});
});
