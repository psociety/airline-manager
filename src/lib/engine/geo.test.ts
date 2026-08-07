import { describe, expect, it } from 'vitest';
import { getAirport } from '$data/airports';
import { bearing, distanceKm, greatCirclePoints, interpolate } from './geo';

describe('geo helpers', () => {
	describe('WHEN measuring the distance between airports', () => {
		it.each`
			from     | to       | expected
			${'BCN'} | ${'MAD'} | ${483}
			${'LHR'} | ${'JFK'} | ${5555}
			${'SYD'} | ${'AKL'} | ${2160}
			${'ATL'} | ${'LAX'} | ${3125}
		`('should measure about $expected km from $from to $to', ({ from, to, expected }) => {
			const result = distanceKm(getAirport(from), getAirport(to));

			// Within 3% of the published great-circle distance.
			expect(result).toBeGreaterThan(expected * 0.97);
			expect(result).toBeLessThan(expected * 1.03);
		});

		it('should be zero between an airport and itself', () => {
			const result = distanceKm(getAirport('BCN'), getAirport('BCN'));

			expect(result).toBe(0);
		});

		it('should be the same in both directions', () => {
			const outbound = distanceKm(getAirport('LHR'), getAirport('SIN'));
			const inbound = distanceKm(getAirport('SIN'), getAirport('LHR'));

			expect(inbound).toBeCloseTo(outbound, 6);
		});
	});

	describe('WHEN heading from one airport to another', () => {
		it('should point roughly west from London to New York', () => {
			const result = bearing(getAirport('LHR'), getAirport('JFK'));

			expect(result).toBeGreaterThan(250);
			expect(result).toBeLessThan(310);
		});

		it('should point roughly south from Frankfurt to Johannesburg', () => {
			const result = bearing(getAirport('FRA'), getAirport('JNB'));

			expect(result).toBeGreaterThan(140);
			expect(result).toBeLessThan(200);
		});

		it('should always report a compass heading', () => {
			const result = bearing(getAirport('SYD'), getAirport('LAX'));

			expect(result).toBeGreaterThanOrEqual(0);
			expect(result).toBeLessThan(360);
		});
	});

	describe('WHEN interpolating along a great circle', () => {
		it('should return the endpoints at nought and one', () => {
			const from = getAirport('BCN');
			const to = getAirport('MAD');

			const start = interpolate(from, to, 0);
			const end = interpolate(from, to, 1);

			expect(start.latitude).toBeCloseTo(from.latitude, 4);
			expect(start.longitude).toBeCloseTo(from.longitude, 4);
			expect(end.latitude).toBeCloseTo(to.latitude, 4);
			expect(end.longitude).toBeCloseTo(to.longitude, 4);
		});

		it('should sit halfway along the route at one half', () => {
			const from = getAirport('LHR');
			const to = getAirport('JFK');
			const total = distanceKm(from, to);

			const middle = interpolate(from, to, 0.5);

			expect(distanceKm(from, middle)).toBeCloseTo(total / 2, 0);
			expect(distanceKm(middle, to)).toBeCloseTo(total / 2, 0);
		});

		it('should cope with an aircraft that has not moved', () => {
			const airport = getAirport('BCN');

			const result = interpolate(airport, airport, 0.5);

			expect(result.latitude).toBe(airport.latitude);
			expect(result.longitude).toBe(airport.longitude);
		});
	});

	describe('WHEN drawing a route on the map', () => {
		it('should return one more point than the number of segments', () => {
			const result = greatCirclePoints(getAirport('BCN'), getAirport('MAD'), 12);

			expect(result).toHaveLength(13);
		});

		it('should start and end at the two airports', () => {
			const from = getAirport('BCN');
			const to = getAirport('MAD');

			const result = greatCirclePoints(from, to, 8);

			expect(result[0][0]).toBeCloseTo(from.latitude, 4);
			expect(result[result.length - 1][1]).toBeCloseTo(to.longitude, 4);
		});
	});
});
