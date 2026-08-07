import { afterEach, describe, expect, it } from 'vitest';
import {
	DAY_MS,
	DAY_NAMES,
	dayIndexOf,
	dayKey,
	dayOfWeekOf,
	formatDuration,
	formatHours,
	gameNow,
	getClockOffset,
	setClockOffset,
	startOfDay,
	timeAt
} from './clock';
import { occurrencesBetween } from './flights';

describe('clock helpers', () => {
	afterEach(() => {
		setClockOffset(0);
	});

	describe('WHEN mapping a timestamp onto the calendar', () => {
		it('should treat 1970-01-01 as day zero', () => {
			expect(dayIndexOf(0)).toBe(0);
			expect(dayIndexOf(DAY_MS - 1)).toBe(0);
			expect(dayIndexOf(DAY_MS)).toBe(1);
		});

		it('should name the epoch a Thursday', () => {
			// 0 = Monday, so Thursday is 3.
			expect(dayOfWeekOf(0)).toBe(3);
			expect(DAY_NAMES[dayOfWeekOf(0)]).toBe('Thu');
		});

		it('should cycle through the week', () => {
			const days = Array.from({ length: 8 }, (_, offset) => dayOfWeekOf(offset));

			expect(days).toEqual([3, 4, 5, 6, 0, 1, 2, 3]);
		});

		it('should format the day key as an ISO date', () => {
			expect(dayKey(0)).toBe('1970-01-01');
			expect(dayKey(19_000)).toBe('2022-01-08');
		});

		it('should place an hour inside the right day', () => {
			const result = timeAt(100, 6);

			expect(result).toBe(startOfDay(100) + 6 * 3_600_000);
			expect(dayIndexOf(result)).toBe(100);
		});
	});

	describe('WHEN the world clock is pushed forward', () => {
		it('should report a time ahead of wall time', () => {
			const before = gameNow();

			setClockOffset(24 * 3_600_000);

			expect(getClockOffset()).toBe(24 * 3_600_000);
			expect(gameNow()).toBeGreaterThanOrEqual(before + 24 * 3_600_000);
		});
	});

	describe('WHEN listing the occurrences of a scheduled leg', () => {
		it('should fire once a week', () => {
			const entry = { dayOfWeek: 0, startHour: 8 };
			const from = startOfDay(100);
			const to = startOfDay(114);

			const result = occurrencesBetween(entry, from, to);

			expect(result).toHaveLength(2);
			for (const at of result) {
				expect(dayOfWeekOf(dayIndexOf(at))).toBe(0);
				expect(at - startOfDay(dayIndexOf(at))).toBe(8 * 3_600_000);
			}
		});

		it('should exclude the lower bound and include the upper one', () => {
			const entry = { dayOfWeek: dayOfWeekOf(100), startHour: 0 };
			const exact = timeAt(100, 0);

			const excluded = occurrencesBetween(entry, exact, exact + 1);
			const included = occurrencesBetween(entry, exact - 1, exact);

			expect(excluded).toEqual([]);
			expect(included).toEqual([exact]);
		});

		it('should return nothing for an empty window', () => {
			const entry = { dayOfWeek: 2, startHour: 10 };
			const at = startOfDay(200);

			const result = occurrencesBetween(entry, at, at);

			expect(result).toEqual([]);
		});

		it('should not skip a leg when a window spans many weeks', () => {
			const entry = { dayOfWeek: 4, startHour: 15 };

			const result = occurrencesBetween(entry, startOfDay(0), startOfDay(28));

			expect(result).toHaveLength(4);
		});
	});

	describe('WHEN formatting a duration for the player', () => {
		it.each`
			milliseconds     | expected
			${0}             | ${'now'}
			${-5000}         | ${'now'}
			${45_000}        | ${'0m 45s'}
			${5 * 60_000}    | ${'5m 00s'}
			${3_600_000}     | ${'1h 00m'}
			${5_400_000}     | ${'1h 30m'}
			${90_000_000}    | ${'1d 1h'}
		`('should render $milliseconds ms as $expected', ({ milliseconds, expected }) => {
			const result = formatDuration(milliseconds);

			expect(result).toBe(expected);
		});

		it.each`
			hours   | expected
			${1}    | ${'1h 00m'}
			${2.5}  | ${'2h 30m'}
			${0.75} | ${'0h 45m'}
		`('should render $hours block hours as $expected', ({ hours, expected }) => {
			const result = formatHours(hours);

			expect(result).toBe(expected);
		});
	});
});
