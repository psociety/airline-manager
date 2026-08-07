import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import AuditPanel from './AuditPanel.svelte';
import type { RouteIntel } from '$engine/audit';
import { routeCargoDemand, routeDemand, vagueRange } from '$engine/demand';

afterEach(cleanup);

const demand = routeDemand('BCN', 'MAD', 483);

const intel = (overrides: Partial<RouteIntel> = {}): RouteIntel => ({
	pairKey: 'BCN-MAD',
	audited: false,
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
	competitors: [],
	...overrides
});

describe('<AuditPanel />', () => {
	describe('WHEN the route has not been opened yet', () => {
		it('should say the market is unknown', () => {
			render(AuditPanel, { props: { intel: intel() } });

			expect(screen.getByText('Market unknown')).toBeTruthy();
			expect(screen.queryByText('Unaudited estimate')).toBeNull();
		});

		it('should show no demand figures at all, not even a range', () => {
			const locked = intel();
			render(AuditPanel, { props: { intel: locked } });

			const range = locked.vague.demand.economy;
			expect(screen.queryByText(`${range.low}–${range.high}`)).toBeNull();
			expect(screen.queryByText(range.label)).toBeNull();
			expect(screen.queryByText('Demand / day')).toBeNull();
		});

		it('should show no fare guidance at all', () => {
			const locked = intel();
			render(AuditPanel, { props: { intel: locked } });

			const range = locked.vague.idealPrice.economy;
			expect(screen.queryByText(`${range.low}–${range.high} €`)).toBeNull();
			expect(screen.queryByText('Ideal fare')).toBeNull();
			expect(
				screen.queryByText(`${demand.idealPrice.economy.toLocaleString('de-DE')} €`)
			).toBeNull();
		});

		it('should still offer the audit', () => {
			const onBuy = vi.fn();
			render(AuditPanel, { props: { intel: intel(), onBuy } });

			expect(screen.getByText(/250k/)).toBeTruthy();
		});

		it('should still name the airlines already flying the pair', () => {
			render(AuditPanel, {
				props: {
					intel: intel({
						competitors: [
							{
								companyId: 3,
								companyName: 'Albion Skyways',
								icao: 'ABS',
								prices: { economy: 110, business: 290, first: 560 },
								seatsPerDay: { economy: 200, business: 20, first: 6 },
								weeklyDepartures: 7
							}
						]
					})
				}
			});

			expect(screen.getByText('ABS · Albion Skyways')).toBeTruthy();
		});

		it('should reveal the exact figures once the audit is paid for', () => {
			render(AuditPanel, { props: { intel: intel({ audited: true }) } });

			expect(screen.getByText('Market audit')).toBeTruthy();
			expect(
				screen.getByText(demand.dailyDemand.economy.toLocaleString('de-DE'))
			).toBeTruthy();
		});
	});

	describe('WHEN the route is operated but not audited', () => {
		it('should label the figures as an estimate', () => {
			render(AuditPanel, { props: { intel: intel(), showEstimate: true } });

			expect(screen.getByText('Unaudited estimate')).toBeTruthy();
		});

		it('should never show the exact daily demand', () => {
			render(AuditPanel, { props: { intel: intel(), showEstimate: true } });

			const exact = demand.dailyDemand.economy.toLocaleString('de-DE');
			expect(screen.queryByText(exact)).toBeNull();
		});

		it('should show a range and a vague label instead', () => {
			const unaudited = intel();
			render(AuditPanel, { props: { intel: unaudited, showEstimate: true } });

			const range = unaudited.vague.demand.economy;
			expect(screen.getByText(`${range.low}–${range.high}`)).toBeTruthy();
			expect(screen.getByText(range.label)).toBeTruthy();
		});

		it('should offer to buy the audit at the quoted price', () => {
			const onBuy = vi.fn();
			render(AuditPanel, { props: { intel: intel(), onBuy, showEstimate: true } });

			expect(screen.getByRole('button')).toBeTruthy();
			expect(screen.getByText(/250k/)).toBeTruthy();
		});

		it('should ask for the audit when the button is pressed', async () => {
			const onBuy = vi.fn();
			render(AuditPanel, { props: { intel: intel(), onBuy, showEstimate: true } });

			await fireEvent.click(screen.getByRole('button'));

			expect(onBuy).toHaveBeenCalledOnce();
		});

		it('should refuse to buy when the airline cannot afford it', () => {
			const onBuy = vi.fn();
			render(AuditPanel, { props: { intel: intel(), onBuy, canAfford: false, showEstimate: true } });

			const button = screen.getByRole('button') as HTMLButtonElement;
			expect(button.disabled).toBe(true);
			expect(screen.getByText('Not enough cash')).toBeTruthy();
		});
	});

	describe('WHEN the route has been audited', () => {
		it('should show the exact demand and fair fares', () => {
			render(AuditPanel, { props: { intel: intel({ audited: true }) } });

			expect(screen.getByText('Market audit')).toBeTruthy();
			expect(
				screen.getByText(demand.dailyDemand.economy.toLocaleString('de-DE'))
			).toBeTruthy();
			expect(
				screen.getByText(`${demand.idealPrice.economy.toLocaleString('de-DE')} €`)
			).toBeTruthy();
		});

		it('should not offer to buy it again', () => {
			render(AuditPanel, { props: { intel: intel({ audited: true }), onBuy: vi.fn() } });

			expect(screen.getByText('Paid')).toBeTruthy();
			expect(screen.queryByRole('button')).toBeNull();
		});
	});

	describe('WHEN rivals fly the same pair', () => {
		it('should list them with their capacity and fares', () => {
			render(AuditPanel, {
				props: {
					intel: intel({
						competitors: [
							{
								companyId: 7,
								companyName: 'Rhein Air',
								icao: 'RHN',
								prices: { economy: 95, business: 260, first: 500 },
								seatsPerDay: { economy: 300, business: 30, first: 8 },
								weeklyDepartures: 14
							}
						]
					})
				}
			});

			expect(screen.getByText('RHN · Rhein Air')).toBeTruthy();
			expect(screen.getByText('14')).toBeTruthy();
			expect(screen.getByText('338')).toBeTruthy();
			expect(screen.getByText('95 €')).toBeTruthy();
		});

		it('should say so when the pair is uncontested', () => {
			render(AuditPanel, { props: { intel: intel(), showEstimate: true } });

			expect(screen.getByText(/Nobody else flies it/)).toBeTruthy();
		});
	});
});
