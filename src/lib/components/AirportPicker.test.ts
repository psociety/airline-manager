import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import AirportPicker from './AirportPicker.svelte';

afterEach(cleanup);

const setup = (props: Record<string, unknown> = {}) => {
	const onSelect = vi.fn();
	const result = render(AirportPicker, { props: { value: null, onSelect, ...props } });
	return { onSelect, ...result };
};

const search = async (query: string) => {
	const field = screen.getByLabelText('Search airports');
	await fireEvent.input(field, { target: { value: query } });
	return field as HTMLInputElement;
};

const optionLabels = () =>
	screen.getAllByRole('button').map((button) => button.textContent?.replace(/\s+/g, ' ').trim());

describe('<AirportPicker />', () => {
	describe('WHEN nothing has been typed', () => {
		it('should offer a search field and a country list', () => {
			setup();

			expect(screen.getByLabelText('Search airports')).toBeTruthy();
			expect(screen.getByLabelText('Browse by country')).toBeTruthy();
		});

		it('should not list any airport until asked', () => {
			setup();

			expect(screen.queryAllByRole('button')).toHaveLength(0);
		});

		it('should list a country’s airports when one is browsed', async () => {
			setup();

			await fireEvent.change(screen.getByLabelText('Browse by country'), {
				target: { value: 'Portugal' }
			});

			const labels = optionLabels();
			expect(labels.length).toBeGreaterThan(0);
			expect(labels.some((label) => label?.includes('LIS'))).toBe(true);
		});
	});

	describe('WHEN a search is typed', () => {
		it('should find an airport by city', async () => {
			setup();

			await search('lisbon');

			expect(optionLabels().some((label) => label?.includes('LIS'))).toBe(true);
		});

		it('should find an airport by IATA code', async () => {
			setup();

			await search('TLV');

			const labels = optionLabels();
			expect(labels).toHaveLength(1);
			expect(labels[0]).toContain('Tel Aviv');
		});

		it('should find an airport by its name', async () => {
			setup();

			await search('heathrow');

			expect(optionLabels().some((label) => label?.includes('LHR'))).toBe(true);
		});

		it('should find airports by country', async () => {
			setup();

			await search('greece');

			expect(optionLabels().some((label) => label?.includes('ATH'))).toBe(true);
		});

		it('should ignore accents so plain typing still matches', async () => {
			setup();

			await search('sao paulo');

			expect(optionLabels().some((label) => label?.includes('GRU'))).toBe(true);
		});

		it('should treat several words as all having to match', async () => {
			setup();

			await search('paris orly');

			const labels = optionLabels();
			expect(labels).toHaveLength(1);
			expect(labels[0]).toContain('ORY');
		});

		it('should say so when nothing matches', async () => {
			setup();

			await search('zzzzz');

			expect(screen.getByText(/No airport matches/)).toBeTruthy();
			expect(screen.queryAllByRole('button')).toHaveLength(0);
		});

		it('should cap the list and say how much was left out', async () => {
			setup();

			// Every airport's country string contains a letter that matches broadly.
			await search('a');

			expect(optionLabels().length).toBeLessThanOrEqual(40);
			expect(screen.getByText(/keep typing to narrow it down/)).toBeTruthy();
		});
	});

	describe('WHEN an airport is chosen', () => {
		it('should report the IATA code', async () => {
			const { onSelect } = setup();
			await search('TLV');

			await fireEvent.click(screen.getAllByRole('button')[0]);

			expect(onSelect).toHaveBeenCalledWith('TLV');
		});

		it('should show the selection instead of the search field', () => {
			setup({ value: 'LIS' });

			expect(screen.getByText(/Lisbon, Portugal/)).toBeTruthy();
			expect(screen.queryByLabelText('Search airports')).toBeNull();
		});

		it('should let the selection be cleared', async () => {
			const { onSelect } = setup({ value: 'LIS' });

			await fireEvent.click(screen.getByLabelText('Clear'));

			expect(onSelect).toHaveBeenCalledWith(null);
		});
	});

	describe('WHEN a code is disabled', () => {
		it('should show it as unavailable and refuse to choose it', async () => {
			const { onSelect } = setup({ disabledCodes: ['TLV'] });
			await search('TLV');

			const option = screen.getAllByRole('button')[0] as HTMLButtonElement;

			expect(option.disabled).toBe(true);
			expect(screen.getByText('in use')).toBeTruthy();

			await fireEvent.click(option);
			expect(onSelect).not.toHaveBeenCalled();
		});

		it('should still allow every other airport', async () => {
			const { onSelect } = setup({ disabledCodes: ['TLV'] });
			await search('lisbon');

			await fireEvent.click(screen.getAllByRole('button')[0]);

			expect(onSelect).toHaveBeenCalledWith('LIS');
		});
	});
});
