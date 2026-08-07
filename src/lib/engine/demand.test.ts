import { describe, expect, it } from 'vitest';
import {
	attractiveness,
	demandShare,
	distanceFactor,
	idealEconomyPrice,
	idealPrices,
	loadFactorForPrice,
	passengersForFlight,
	routeDemand,
	vagueRange
} from './demand';

describe('demand helpers', () => {
	describe('WHEN weighting a distance', () => {
		it.each`
			distance | comparison   | other
			${100}   | ${'below'}   | ${900}
			${900}   | ${'above'}   | ${18000}
			${1200}  | ${'above'}   | ${9000}
		`(
			'should rate $distance km $comparison $other km',
			({ distance, comparison, other }) => {
				const result = distanceFactor(distance);
				const reference = distanceFactor(other);

				if (comparison === 'below') expect(result).toBeLessThan(reference);
				else expect(result).toBeGreaterThan(reference);
			}
		);

		it('should peak around short and medium haul', () => {
			const result = distanceFactor(900);

			expect(result).toBe(1);
		});
	});

	describe('WHEN pricing a fair fare', () => {
		it.each`
			distance | minimum | maximum
			${500}   | ${75}   | ${100}
			${1000}  | ${110}  | ${140}
			${5000}  | ${380}  | ${460}
			${10000} | ${700}  | ${820}
		`(
			'should charge between $minimum and $maximum € for $distance km in economy',
			({ distance, minimum, maximum }) => {
				const result = idealEconomyPrice(distance);

				expect(result).toBeGreaterThanOrEqual(minimum);
				expect(result).toBeLessThanOrEqual(maximum);
			}
		);

		it('should charge more per seat in the premium cabins', () => {
			const result = idealPrices(2000);

			expect(result.business).toBeGreaterThan(result.economy);
			expect(result.first).toBeGreaterThan(result.business);
		});

		it('should charge less per kilometre on long haul than on short haul', () => {
			const shortHaul = idealEconomyPrice(500) / 500;
			const longHaul = idealEconomyPrice(10_000) / 10_000;

			expect(longHaul).toBeLessThan(shortHaul);
		});
	});

	describe('WHEN generating demand for a pair', () => {
		it('should be identical every time it is asked', () => {
			const first = routeDemand('BCN', 'MAD', 483);
			const second = routeDemand('BCN', 'MAD', 483);

			expect(second).toEqual(first);
		});

		it('should not depend on the direction of travel', () => {
			const outbound = routeDemand('BCN', 'MAD', 483);
			const inbound = routeDemand('MAD', 'BCN', 483);

			expect(inbound.dailyDemand).toEqual(outbound.dailyDemand);
			expect(inbound.pairKey).toBe(outbound.pairKey);
		});

		it('should differ between pairs', () => {
			const first = routeDemand('BCN', 'MAD', 483);
			const second = routeDemand('BCN', 'LHR', 1146);

			expect(second.dailyDemand).not.toEqual(first.dailyDemand);
		});

		it('should carry more economy than business and more business than first', () => {
			const result = routeDemand('JFK', 'LHR', 5540);

			expect(result.dailyDemand.economy).toBeGreaterThan(result.dailyDemand.business);
			expect(result.dailyDemand.business).toBeGreaterThan(result.dailyDemand.first);
		});

		it('should generate more demand between two major hubs than two small ones', () => {
			const majorPair = routeDemand('LHR', 'JFK', 5540);
			const minorPair = routeDemand('ASU', 'SAL', 4600);

			expect(majorPair.dailyDemand.economy).toBeGreaterThan(minorPair.dailyDemand.economy);
		});
	});

	describe('WHEN pricing against the fair fare', () => {
		it.each`
			price  | ideal  | expected
			${100} | ${100} | ${1}
			${150} | ${100} | ${0.4}
			${200} | ${100} | ${0}
		`('should fill $expected of the cabin at $price against $ideal', ({ price, ideal, expected }) => {
			const result = loadFactorForPrice(price, ideal);

			expect(result).toBeCloseTo(expected, 5);
		});

		it('should cap the bonus for undercutting the market', () => {
			const result = loadFactorForPrice(1, 500);

			expect(result).toBe(1.15);
		});
	});

	describe('WHEN sharing demand with competitors', () => {
		it('should take everything when nobody else flies the pair', () => {
			const result = demandShare({ seatsPerDay: 180, price: 100 }, [], 100);

			expect(result).toBe(1);
		});

		it('should split evenly between identical carriers', () => {
			const result = demandShare({ seatsPerDay: 180, price: 100 }, [{ seatsPerDay: 180, price: 100 }], 100);

			expect(result).toBeCloseTo(0.5, 5);
		});

		it('should win a bigger share when undercutting a rival', () => {
			const cheaper = demandShare({ seatsPerDay: 180, price: 80 }, [{ seatsPerDay: 180, price: 120 }], 100);

			expect(cheaper).toBeGreaterThan(0.5);
		});

		it('should lose share to a rival with more capacity at the same fare', () => {
			const result = demandShare({ seatsPerDay: 100, price: 100 }, [{ seatsPerDay: 400, price: 100 }], 100);

			expect(result).toBeLessThan(0.3);
		});

		it('should give nothing to a carrier with no seats on offer', () => {
			const result = demandShare({ seatsPerDay: 0, price: 100 }, [{ seatsPerDay: 180, price: 100 }], 100);

			expect(result).toBe(0);
		});
	});

	describe('WHEN measuring a carrier pull', () => {
		it('should pull harder with a cheaper fare', () => {
			const cheap = attractiveness(180, 80, 100);
			const expensive = attractiveness(180, 140, 100);

			expect(cheap).toBeGreaterThan(expensive);
		});

		it('should never fall to zero for an over-priced but operating service', () => {
			const result = attractiveness(180, 10_000, 100);

			expect(result).toBeGreaterThan(0);
		});
	});

	describe('WHEN filling a single departure', () => {
		const demand = routeDemand('LHR', 'JFK', 5540);

		it('should never board more passengers than there are seats', () => {
			const result = passengersForFlight({
				demand,
				prices: { economy: 1, business: 1, first: 1 },
				seats: { economy: 20, business: 4, first: 2 },
				flightsPerDay: 1,
				competitors: []
			});

			expect(result.economy).toBeLessThanOrEqual(20);
			expect(result.business).toBeLessThanOrEqual(4);
			expect(result.first).toBeLessThanOrEqual(2);
		});

		it('should board nobody in a class with no seats', () => {
			const result = passengersForFlight({
				demand,
				prices: demand.idealPrice,
				seats: { economy: 180, business: 0, first: 0 },
				flightsPerDay: 1,
				competitors: []
			});

			expect(result.business).toBe(0);
			expect(result.first).toBe(0);
		});

		it('should board fewer passengers as the fare rises', () => {
			// A cabin far larger than the market, so the seat cap never masks the effect.
			const base = {
				demand,
				seats: { economy: 5_000, business: 500, first: 200 },
				flightsPerDay: 1,
				competitors: []
			};

			const cheap = passengersForFlight({ ...base, prices: demand.idealPrice });
			const dear = passengersForFlight({
				...base,
				prices: {
					economy: demand.idealPrice.economy * 1.6,
					business: demand.idealPrice.business * 1.6,
					first: demand.idealPrice.first * 1.6
				}
			});

			expect(dear.economy).toBeLessThan(cheap.economy);
		});

		it('should split a day of demand across more departures', () => {
			const base = {
				demand,
				prices: demand.idealPrice,
				seats: { economy: 5_000, business: 500, first: 200 },
				competitors: []
			};

			const single = passengersForFlight({ ...base, flightsPerDay: 1 });
			const many = passengersForFlight({ ...base, flightsPerDay: 6 });

			expect(many.economy).toBeLessThan(single.economy);
		});

		it('should lose passengers to a competitor on the same pair', () => {
			const base = {
				demand,
				prices: demand.idealPrice,
				seats: { economy: 5_000, business: 500, first: 200 },
				flightsPerDay: 1
			};

			const alone = passengersForFlight({ ...base, competitors: [] });
			const contested = passengersForFlight({
				...base,
				competitors: [
					{
						companyId: 2,
						companyName: 'Rival',
						seatsPerDay: { economy: 5_000, business: 500, first: 200 },
						prices: demand.idealPrice
					}
				]
			});

			expect(contested.economy).toBeLessThan(alone.economy);
		});
	});

	describe('WHEN fuzzing figures for an unaudited route', () => {
		it('should be stable for the same pair and field', () => {
			const first = vagueRange(240, 'BCN-MAD', 'demand-economy');
			const second = vagueRange(240, 'BCN-MAD', 'demand-economy');

			expect(second).toEqual(first);
		});

		it('should bracket a range around the true figure', () => {
			const result = vagueRange(240, 'BCN-MAD', 'demand-economy');

			expect(result.low).toBeLessThan(result.high);
			expect(result.high).toBeGreaterThan(150);
			expect(result.low).toBeLessThan(340);
		});

		it.each`
			exact  | label
			${10}  | ${'very low'}
			${80}  | ${'low'}
			${200} | ${'medium'}
			${450} | ${'high'}
			${900} | ${'very high'}
		`('should label $exact daily passengers as $label', ({ exact, label }) => {
			const result = vagueRange(exact, 'BCN-MAD', 'demand-economy');

			expect(result.label).toBe(label);
		});
	});
});
