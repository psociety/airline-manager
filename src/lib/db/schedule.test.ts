import { describe, expect, it } from 'vitest';
import { generateRegistration, scheduleOverlaps, slugify } from './repo';

describe('schedule helpers', () => {
	const monday = (startHour: number, blockHours: number) => ({
		dayOfWeek: 0,
		startHour,
		blockHours
	});

	describe('WHEN checking a slot against an existing timetable', () => {
		it('should accept a slot on an empty day', () => {
			const result = scheduleOverlaps([monday(8, 4)], { dayOfWeek: 1, startHour: 8, blockHours: 4 });

			expect(result).toBe(false);
		});

		it.each`
			startHour | blockHours | overlaps | reason
			${8}      | ${4}       | ${true}  | ${'the same slot'}
			${10}     | ${2}       | ${true}  | ${'starting inside the leg'}
			${6}      | ${4}       | ${true}  | ${'ending inside the leg'}
			${6}      | ${10}      | ${true}  | ${'swallowing the leg'}
			${12}     | ${2}       | ${false} | ${'starting the hour it lands'}
			${4}      | ${4}       | ${false} | ${'ending the hour it departs'}
			${20}     | ${3}       | ${false} | ${'a clear evening slot'}
		`(
			'should report $overlaps for a leg at $startHour for $blockHours hours ($reason)',
			({ startHour, blockHours, overlaps }) => {
				const existing = [monday(8, 4)];

				const result = scheduleOverlaps(existing, { dayOfWeek: 0, startHour, blockHours });

				expect(result).toBe(overlaps);
			}
		);

		it('should ignore the entry being moved', () => {
			const existing = [monday(8, 4), monday(14, 2)];

			const result = scheduleOverlaps(existing, monday(8, 4), 0);

			expect(result).toBe(false);
		});

		it('should check every existing leg on the day', () => {
			const existing = [monday(0, 3), monday(6, 3), monday(18, 3)];

			expect(scheduleOverlaps(existing, monday(7, 1))).toBe(true);
			expect(scheduleOverlaps(existing, monday(12, 4))).toBe(false);
		});
	});

	describe('WHEN slugifying an airline name', () => {
		it.each`
			name                    | expected
			${'Raca Airline'}       | ${'raca-airline'}
			${'Lumière Lignes'}     | ${'lumiere-lignes'}
			${'  Spaced   Out  '}   | ${'spaced-out'}
			${'Air!!!Nine###'}      | ${'air-nine'}
			${'123'}                | ${'123'}
			${'!!!'}                | ${'airline'}
		`('should turn $name into $expected', ({ name, expected }) => {
			const result = slugify(name);

			expect(result).toBe(expected);
		});

		it('should never produce a leading or trailing dash', () => {
			const result = slugify('---Edge Case---');

			expect(result.startsWith('-')).toBe(false);
			expect(result.endsWith('-')).toBe(false);
		});
	});

	describe('WHEN generating a registration', () => {
		it('should start with the airline code', () => {
			const result = generateRegistration('RCA', 0);

			expect(result.startsWith('RC-')).toBe(true);
		});

		it('should differ between aircraft of the same airline', () => {
			const registrations = new Set(
				Array.from({ length: 20 }, (_, index) => generateRegistration('RCA', index))
			);

			expect(registrations.size).toBe(20);
		});
	});
});
