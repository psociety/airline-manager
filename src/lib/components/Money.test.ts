import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import Money from './Money.svelte';

afterEach(cleanup);

describe('<Money />', () => {
	describe('WHEN an amount is rendered', () => {
		it.each`
			amount        | expected
			${1_234_567}  | ${'1.234.567 €'}
			${0}          | ${'0 €'}
			${-5_000}     | ${'-5.000 €'}
		`('should render $amount as $expected', ({ amount, expected }) => {
			render(Money, { props: { amount } });

			expect(screen.getByText(expected)).toBeTruthy();
		});

		it('should shorten a large amount when asked to be compact', () => {
			render(Money, { props: { amount: 2_400_000, compact: true } });

			expect(screen.getByText('2.4M €')).toBeTruthy();
		});

		it('should mark a positive amount with a sign when asked', () => {
			render(Money, { props: { amount: 1_000, signed: true } });

			expect(screen.getByText('+1.000 €')).toBeTruthy();
		});

		it('should not put a sign on a negative amount, which already has one', () => {
			render(Money, { props: { amount: -1_000, signed: true } });

			expect(screen.getByText('-1.000 €')).toBeTruthy();
		});
	});

	describe('WHEN colour is requested', () => {
		it('should colour income and expense differently', () => {
			const { container: income } = render(Money, {
				props: { amount: 500, colour: true }
			});
			const { container: expense } = render(Money, {
				props: { amount: -500, colour: true }
			});

			expect(income.querySelector('.e-money--positive')).toBeTruthy();
			expect(expense.querySelector('.e-money--negative')).toBeTruthy();
		});

		it('should leave a zero balance uncoloured', () => {
			const { container } = render(Money, { props: { amount: 0, colour: true } });

			expect(container.querySelector('.e-money--positive')).toBeNull();
			expect(container.querySelector('.e-money--negative')).toBeNull();
		});
	});
});
