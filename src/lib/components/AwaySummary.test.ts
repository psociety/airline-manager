import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import AwaySummary from './AwaySummary.svelte';
import type { BidOutcome } from '$engine/takeover';
import type { CatchUpSummary } from '$engine/tick';

afterEach(cleanup);

const outcome = (overrides: Partial<BidOutcome> = {}): BidOutcome => ({
	bidId: 1,
	targetIcao: 'SVN',
	targetName: 'Savanna Air',
	status: 'succeeded',
	sharesWon: 1_501,
	spent: 9_271_677,
	refunded: 0,
	defence: null,
	tookControl: true,
	...overrides
});

const summary = (overrides: Partial<CatchUpSummary> = {}): CatchUpSummary => ({
	from: 0,
	to: 3 * 24 * 3_600_000,
	daysProcessed: 3,
	flightsFlown: 12,
	accidents: 0,
	deliveries: 0,
	maintenanceStarted: 0,
	skippedDays: 0,
	ceoSharesPaid: 0,
	bidOutcomes: [],
	...overrides
});

describe('<AwaySummary />', () => {
	describe('WHEN no offer closed while the player was away', () => {
		it('should say nothing about takeovers at all', () => {
			render(AwaySummary, { summary: summary() });

			expect(screen.queryByText('Takeover offers')).toBeNull();
		});
	});

	describe('WHEN an offer was won', () => {
		it('should name the airline and what it cost', () => {
			render(AwaySummary, { summary: summary({ bidOutcomes: [outcome()] }) });

			expect(screen.getByText('Takeover offers')).toBeTruthy();
			expect(screen.getByText(/SVN · Savanna Air/)).toBeTruthy();
			expect(screen.getByText(/Won 1\.501/)).toBeTruthy();
			expect(screen.getByText(/control/)).toBeTruthy();
		});
	});

	describe('WHEN an offer lapsed', () => {
		it('should report what came back rather than what was won', () => {
			const lapsed = outcome({
				status: 'failed',
				sharesWon: 0,
				spent: 0,
				refunded: 9_086_243,
				tookControl: false
			});

			render(AwaySummary, { summary: summary({ bidOutcomes: [lapsed] }) });

			expect(screen.getByText(/Lapsed/)).toBeTruthy();
			expect(screen.queryByText(/Won /)).toBeNull();
		});
	});

	describe('WHEN the board did something about it', () => {
		it('should print what the board did in its own words', () => {
			const defended = outcome({
				defence: 'The board bought 300 shares of its own float back'
			});

			render(AwaySummary, { summary: summary({ bidOutcomes: [defended] }) });

			expect(
				screen.getByText(/The board bought 300 shares of its own float back/)
			).toBeTruthy();
		});
	});

	describe('WHEN several offers closed at once', () => {
		it('should report every one of them', () => {
			const outcomes = [
				outcome(),
				outcome({ bidId: 2, targetIcao: 'IBV', targetName: 'Iberavia' })
			];

			render(AwaySummary, { summary: summary({ bidOutcomes: outcomes }) });

			expect(screen.getByText(/SVN · Savanna Air/)).toBeTruthy();
			expect(screen.getByText(/IBV · Iberavia/)).toBeTruthy();
		});
	});
});
