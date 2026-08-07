import { describe, expect, it } from 'vitest';
import { AIRPORTS, COUNTRIES, getAirport } from './airports';
import { TOTAL_GATE_COUNT, gateCountFor, maxCategoryForAirport } from './gates';
import gateData from './airport_gates.json';

const gateCounts = (gateData as { gateCounts: Record<string, number> }).gateCounts;

/** Hubs `src/lib/db/seed.ts` pins its AI airlines to. Removing one breaks seeding. */
const SEEDED_AI_HUBS = [
	'ORD', 'JFK', 'LHR', 'FRA', 'CDG', 'MAD', 'DXB', 'HND', 'HKG', 'SYD', 'GRU', 'JNB'
];

describe('airport data', () => {
	describe('WHEN the dataset is loaded', () => {
		it('should hold the full set of airports', () => {
			expect(AIRPORTS).toHaveLength(300);
		});

		it('should cover 157 countries', () => {
			const countries = new Set(AIRPORTS.map((airport) => airport.countryCode));

			expect(countries.size).toBe(157);
		});

		it('should pin the world gate total, so a data change is visible here first', () => {
			expect(TOTAL_GATE_COUNT).toBe(15204);
		});
	});

	describe('WHEN every entry is checked', () => {
		it('should give each airport a unique three-letter IATA code', () => {
			const codes = AIRPORTS.map((airport) => airport.iataCode);
			const malformed = codes.filter((code) => !/^[A-Z]{3}$/.test(code));

			expect(malformed).toEqual([]);
			expect(new Set(codes).size).toBe(codes.length);
		});

		it('should give each airport a three or four character ICAO code', () => {
			const malformed = AIRPORTS.filter((airport) => !/^[A-Z0-9]{3,4}$/.test(airport.icaoCode));

			expect(malformed.map((airport) => airport.iataCode)).toEqual([]);
		});

		it('should place every airport at real coordinates', () => {
			const offWorld = AIRPORTS.filter(
				(airport) =>
					!Number.isFinite(airport.latitude) ||
					!Number.isFinite(airport.longitude) ||
					Math.abs(airport.latitude) > 90 ||
					Math.abs(airport.longitude) > 180 ||
					(airport.latitude === 0 && airport.longitude === 0)
			);

			expect(offWorld.map((airport) => airport.iataCode)).toEqual([]);
		});

		it('should name a city, country, continent and timezone for every airport', () => {
			const incomplete = AIRPORTS.filter(
				(airport) =>
					!airport.city || !airport.country || !airport.continent || !airport.timezone
			);

			expect(incomplete.map((airport) => airport.iataCode)).toEqual([]);
		});

		it('should never fall back to a placeholder timezone', () => {
			const placeholder = AIRPORTS.filter((airport) => airport.timezone === 'UTC');

			expect(placeholder.map((airport) => airport.iataCode)).toEqual([]);
		});

		it('should grade every airport between tier 1 and 10', () => {
			const outOfRange = AIRPORTS.filter((airport) => airport.tier < 1 || airport.tier > 10);

			expect(outOfRange.map((airport) => airport.iataCode)).toEqual([]);
		});

		it('should give every airport a runway long enough to land something', () => {
			const shortest = Math.min(...AIRPORTS.map((airport) => airport.runwayLength));

			expect(shortest).toBeGreaterThanOrEqual(1700);
		});

		it('should keep charges inside the ranges the economy is balanced against', () => {
			const outOfRange = AIRPORTS.filter(
				(airport) =>
					airport.landingFeePerTon < 3 ||
					airport.landingFeePerTon > 11 ||
					airport.passengerFee < 9 ||
					airport.passengerFee > 35
			);

			expect(outOfRange.map((airport) => airport.iataCode)).toEqual([]);
		});

		it('should keep demand modifiers inside the range the demand model expects', () => {
			const outOfRange = AIRPORTS.filter((airport) =>
				Object.values(airport.demandModifiers).some((value) => value < 0.7 || value > 2)
			);

			expect(outOfRange.map((airport) => airport.iataCode)).toEqual([]);
		});

		it('should use one spelling per country', () => {
			const namesByCode = new Map<string, Set<string>>();
			for (const airport of AIRPORTS) {
				const names = namesByCode.get(airport.countryCode) ?? new Set();
				names.add(airport.country);
				namesByCode.set(airport.countryCode, names);
			}

			const conflicting = [...namesByCode.entries()].filter(([, names]) => names.size > 1);

			expect(conflicting).toEqual([]);
		});
	});

	describe('WHEN gates are looked up', () => {
		it('should have a curated count for every airport, never the fallback', () => {
			const missing = AIRPORTS.filter((airport) => !(airport.iataCode in gateCounts));

			expect(missing.map((airport) => airport.iataCode)).toEqual([]);
		});

		it('should not carry gate counts for airports that no longer exist', () => {
			const codes = new Set(AIRPORTS.map((airport) => airport.iataCode));
			const orphans = Object.keys(gateCounts).filter((code) => !codes.has(code));

			expect(orphans).toEqual([]);
		});

		it('should give every airport at least six stands', () => {
			const tooFew = AIRPORTS.filter((airport) => gateCountFor(airport.iataCode) < 6);

			expect(tooFew.map((airport) => airport.iataCode)).toEqual([]);
		});
	});

	describe('WHEN the seed picks its hubs', () => {
		it.each(SEEDED_AI_HUBS.map((hub) => ({ hub })))(
			'should still contain $hub',
			({ hub }) => {
				expect(() => getAirport(hub)).not.toThrow();
			}
		);
	});

	describe('WHEN airports are grouped for the pickers', () => {
		it('should group every airport under exactly one country', () => {
			const grouped = COUNTRIES.flatMap((group) => group.airports);

			expect(grouped).toHaveLength(AIRPORTS.length);
			expect(new Set(grouped.map((airport) => airport.iataCode)).size).toBe(AIRPORTS.length);
		});

		it('should sort countries alphabetically', () => {
			const names = COUNTRIES.map((group) => group.country);
			const sorted = [...names].sort((left, right) => left.localeCompare(right));

			expect(names).toEqual(sorted);
		});
	});

	describe('WHEN a well-known airport is read back', () => {
		it.each`
			code     | city         | country          | runway  | maxCategory
			${'LIS'} | ${'Lisbon'}  | ${'Portugal'}    | ${3810} | ${10}
			${'EWR'} | ${'Newark'}  | ${'United States'} | ${3353} | ${8}
			${'ORY'} | ${'Paris'}   | ${'France'}      | ${3650} | ${10}
			${'ATH'} | ${'Athens'}  | ${'Greece'}      | ${4000} | ${10}
			${'BER'} | ${'Berlin'}  | ${'Germany'}     | ${4000} | ${10}
		`(
			'should describe $code as $city, $country with a $runway m runway',
			({ code, city, country, runway, maxCategory }) => {
				const airport = getAirport(code as string);

				expect(airport.city).toBe(city);
				expect(airport.country).toBe(country);
				expect(airport.runwayLength).toBe(runway);
				expect(maxCategoryForAirport(airport)).toBe(maxCategory);
			}
		);

		it('should place Lisbon within a kilometre of its real position', () => {
			const lisbon = getAirport('LIS');

			expect(lisbon.latitude).toBeCloseTo(38.7813, 2);
			expect(lisbon.longitude).toBeCloseTo(-9.1359, 2);
		});

		it('should have corrected the runway lengths that were wrong', () => {
			expect(getAirport('PHL').runwayLength).toBe(3658);
			expect(getAirport('BUD').runwayLength).toBe(3707);
		});

		it('should have moved Dakar to the airport actually in service', () => {
			const dakar = getAirport('DKR');

			expect(dakar.latitude).toBeCloseTo(14.671, 2);
			expect(dakar.longitude).toBeCloseTo(-17.072, 2);
		});

		it('should keep Tegel, so saves holding a gate there still load', () => {
			expect(() => getAirport('TXL')).not.toThrow();
		});
	});
});
