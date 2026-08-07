import { describe, expect, it } from 'vitest';
import { AIRPORTS, getAirport } from './airports';
import {
	gateCountFor,
	gatePrice,
	gatesForAirport,
	maxCategoryForAirport,
	smallestGateForCategory
} from './gates';

describe('gates helpers', () => {
	describe('WHEN generating an airport stand list', () => {
		it('should produce exactly the curated number of gates', () => {
			const result = gatesForAirport('ATL');

			expect(result).toHaveLength(gateCountFor('ATL'));
			expect(result).toHaveLength(192);
		});

		it('should never exceed the category the runway allows', () => {
			const offenders = AIRPORTS.filter((airport) => {
				const cap = maxCategoryForAirport(airport);
				return gatesForAirport(airport.iataCode).some((gate) => gate.maxCategory > cap);
			});

			expect(offenders).toEqual([]);
		});

		it('should always include at least one stand of the airport maximum', () => {
			const offenders = AIRPORTS.filter((airport) => {
				const cap = maxCategoryForAirport(airport);
				return !gatesForAirport(airport.iataCode).some((gate) => gate.maxCategory === cap);
			});

			expect(offenders).toEqual([]);
		});

		it('should give every gate a unique number within the airport', () => {
			const offenders = AIRPORTS.filter((airport) => {
				const gates = gatesForAirport(airport.iataCode);
				return new Set(gates.map((gate) => gate.number)).size !== gates.length;
			});

			expect(offenders).toEqual([]);
		});

		it('should be deterministic across calls', () => {
			const first = gatesForAirport('LHR');
			const second = gatesForAirport('LHR');

			expect(second).toEqual(first);
		});

		it('should cap a short-runway airport below widebody ratings', () => {
			const wellington = getAirport('WLG');

			const result = maxCategoryForAirport(wellington);

			expect(result).toBe(4);
		});
	});

	describe('WHEN pricing a gate', () => {
		it('should charge more at a bigger hub for the same rating', () => {
			const majorHub = gatePrice(10, 6);
			const minorHub = gatePrice(4, 6);

			expect(majorHub).toBeGreaterThan(minorHub);
		});

		it('should charge more for a heavier rating at the same airport', () => {
			const widebody = gatePrice(8, 10);
			const regional = gatePrice(8, 2);

			expect(widebody).toBeGreaterThan(regional);
		});

		it('should keep a starter airport gate affordable on the opening balance', () => {
			const result = gatePrice(7, 6);

			expect(result).toBeLessThan(10_000_000);
		});
	});

	describe('WHEN choosing a stand for a fleet', () => {
		const stands = [
			{ maxCategory: 2 },
			{ maxCategory: 4 },
			{ maxCategory: 6 },
			{ maxCategory: 8 },
			{ maxCategory: 10 }
		];

		it.each`
			required | expected
			${1}     | ${2}
			${2}     | ${2}
			${3}     | ${4}
			${6}     | ${6}
			${9}     | ${10}
			${10}    | ${10}
		`('should take a category $expected stand for a category $required aircraft', ({ required, expected }) => {
			const result = smallestGateForCategory(stands, required);

			expect(result?.maxCategory).toBe(expected);
		});

		it('should find nothing when every stand is too small', () => {
			const result = smallestGateForCategory([{ maxCategory: 2 }, { maxCategory: 4 }], 6);

			expect(result).toBeNull();
		});

		it('should find nothing at an airport with no free stands', () => {
			const result = smallestGateForCategory([], 2);

			expect(result).toBeNull();
		});

		it('should not depend on the order the stands arrive in', () => {
			const shuffled = [{ maxCategory: 10 }, { maxCategory: 4 }, { maxCategory: 8 }];

			const result = smallestGateForCategory(shuffled, 5);

			expect(result?.maxCategory).toBe(8);
		});
	});
});
