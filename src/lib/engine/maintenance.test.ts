import { describe, expect, it } from 'vitest';
import { AIRCRAFT_MODELS, getModel } from '$data/aircraft';
import {
	MAX_ACCIDENT_PROBABILITY,
	accidentProbability,
	incidentBaseAmount,
	isMaintenanceDue,
	maintenanceProgress,
	overrunKm,
	resolveLawsuit
} from './maintenance';

const model = () => {
	const found = AIRCRAFT_MODELS.find((candidate) => candidate.name === 'A320-200');
	if (!found) throw new Error('missing A320-200');
	return found;
};

const aircraftAt = (kmSinceMaintenance: number) => ({
	modelId: model().id,
	kmSinceMaintenance
});

describe('maintenance helpers', () => {
	describe('WHEN an airframe is inside its service interval', () => {
		it('should have no overrun and no accident risk', () => {
			const interval = getModel(model().id).maintenanceIntervalKm;
			const aircraft = aircraftAt(interval - 1);

			expect(overrunKm(aircraft)).toBe(0);
			expect(isMaintenanceDue(aircraft)).toBe(false);
			expect(accidentProbability(aircraft)).toBe(0);
		});

		it('should report how far through the interval it is', () => {
			const interval = getModel(model().id).maintenanceIntervalKm;

			const result = maintenanceProgress(aircraftAt(interval / 2));

			expect(result).toBeCloseTo(0.5, 5);
		});
	});

	describe('WHEN maintenance is put off', () => {
		it('should start taking risk only past the interval', () => {
			const interval = getModel(model().id).maintenanceIntervalKm;

			expect(accidentProbability(aircraftAt(interval))).toBe(0);
			expect(accidentProbability(aircraftAt(interval + 1))).toBeGreaterThan(0);
		});

		it('should grow the risk the longer it is overdue', () => {
			const interval = getModel(model().id).maintenanceIntervalKm;

			const slightly = accidentProbability(aircraftAt(interval * 1.1));
			const badly = accidentProbability(aircraftAt(interval * 1.5));
			const recklessly = accidentProbability(aircraftAt(interval * 2));

			expect(badly).toBeGreaterThan(slightly);
			expect(recklessly).toBeGreaterThan(badly);
		});

		it('should never exceed the cap however overdue it gets', () => {
			const interval = getModel(model().id).maintenanceIntervalKm;

			const result = accidentProbability(aircraftAt(interval * 500));

			expect(result).toBe(MAX_ACCIDENT_PROBABILITY);
		});

		it('should keep a single flight low-risk when only slightly overdue', () => {
			const interval = getModel(model().id).maintenanceIntervalKm;

			const result = accidentProbability(aircraftAt(interval * 1.05));

			expect(result).toBeLessThan(0.01);
		});
	});

	describe('WHEN damages are claimed', () => {
		it.each`
			passengers | roll   | minimum
			${0}       | ${0}   | ${750_000}
			${180}     | ${0.5} | ${4_000_000}
			${400}     | ${1}   | ${15_000_000}
		`(
			'should claim at least $minimum € for $passengers passengers',
			({ passengers, roll, minimum }) => {
				const result = incidentBaseAmount(passengers, roll);

				expect(result).toBeGreaterThanOrEqual(minimum);
			}
		);

		it('should claim more for a fuller aircraft', () => {
			const light = incidentBaseAmount(20, 0.5);
			const heavy = incidentBaseAmount(300, 0.5);

			expect(heavy).toBeGreaterThan(light);
		});
	});

	describe('WHEN a claim goes to court', () => {
		it('should cost nothing when the airline wins', () => {
			const result = resolveLawsuit(5_000_000, 0.1, 0.5);

			expect(result.won).toBe(true);
			expect(result.amount).toBe(0);
		});

		it.each`
			penaltyRoll | expected
			${0}        | ${5_500_000}
			${0.5}      | ${7_750_000}
			${1}        | ${10_000_000}
		`(
			'should cost $expected € when losing with a penalty roll of $penaltyRoll',
			({ penaltyRoll, expected }) => {
				const result = resolveLawsuit(5_000_000, 0.9, penaltyRoll);

				expect(result.won).toBe(false);
				expect(result.amount).toBe(expected);
			}
		);

		it('should never cost less than the original claim once lost', () => {
			const base = 5_000_000;

			const result = resolveLawsuit(base, 0.99, 0);

			expect(result.amount).toBeGreaterThan(base);
			expect(result.amount).toBeLessThanOrEqual(base * 2);
		});

		it('should be an even chance over many rolls', () => {
			const outcomes = Array.from({ length: 1000 }, (_, index) =>
				resolveLawsuit(1_000_000, index / 1000, 0.5)
			);
			const wins = outcomes.filter((outcome) => outcome.won).length;

			expect(wins).toBe(500);
		});
	});
});
