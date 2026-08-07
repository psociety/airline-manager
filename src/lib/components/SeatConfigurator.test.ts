import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import SeatConfigurator from './SeatConfigurator.svelte';
import { AIRCRAFT_MODELS, usedSeatSlots } from '$data/aircraft';
import type { SeatConfig } from '$data/types';

const model = () => {
	const found = AIRCRAFT_MODELS.find((candidate) => candidate.name === 'A320-200');
	if (!found) throw new Error('missing A320-200');
	return found;
};

const CLASS_INDEX = { economy: 0, business: 1, first: 2 } as const;

const setup = (seats: SeatConfig) => {
	const onChange = vi.fn();
	render(SeatConfigurator, { props: { model: model(), seats, onChange } });

	// Each class renders a slider and a number box, in economy/business/first order.
	const numberBoxes = screen.getAllByRole('spinbutton') as HTMLInputElement[];
	const sliders = screen.getAllByRole('slider') as HTMLInputElement[];

	return { onChange, numberBoxes, sliders };
};

const lastConfig = (onChange: ReturnType<typeof vi.fn>): SeatConfig =>
	onChange.mock.calls[onChange.mock.calls.length - 1][0] as SeatConfig;

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

describe('<SeatConfigurator />', () => {
	describe('WHEN a cabin is shown', () => {
		it('should report the slots used against the airframe maximum', () => {
			setup({ economy: 100, business: 10, first: 2 });

			expect(screen.getByText(`128 / ${model().seats}`)).toBeTruthy();
		});

		it('should offer a slider and a number box per passenger class', () => {
			const { numberBoxes, sliders } = setup({ economy: 100, business: 0, first: 0 });

			expect(numberBoxes).toHaveLength(3);
			expect(sliders).toHaveLength(3);
		});

		it('should show the seat count of each class in its number box', () => {
			const { numberBoxes } = setup({ economy: 100, business: 10, first: 2 });

			expect(numberBoxes[CLASS_INDEX.economy].value).toBe('100');
			expect(numberBoxes[CLASS_INDEX.business].value).toBe('10');
			expect(numberBoxes[CLASS_INDEX.first].value).toBe('2');
		});

		it('should say how many slots are still unused', () => {
			setup({ economy: 100, business: 0, first: 0 });

			expect(screen.getByText(/80 slots? unused/)).toBeTruthy();
		});

		it('should say the cabin is full when every slot is taken', () => {
			setup({ economy: model().seats, business: 0, first: 0 });

			expect(screen.getByText('Cabin full.')).toBeTruthy();
		});

		it('should cap each slider at what the remaining slots allow', () => {
			const { sliders } = setup({ economy: 0, business: 0, first: 0 });

			expect(sliders[CLASS_INDEX.economy].max).toBe(String(model().seats));
			expect(sliders[CLASS_INDEX.business].max).toBe(String(model().seats / 2));
			expect(sliders[CLASS_INDEX.first].max).toBe(String(model().seats / 4));
		});
	});

	describe('WHEN a class is changed', () => {
		it('should report the new configuration', async () => {
			const { onChange, numberBoxes } = setup({ economy: 100, business: 0, first: 0 });

			await fireEvent.input(numberBoxes[CLASS_INDEX.economy], { target: { value: '120' } });

			expect(lastConfig(onChange)).toEqual({ economy: 120, business: 0, first: 0 });
		});

		it('should clamp a request that would overflow the airframe', async () => {
			const { onChange, numberBoxes } = setup({ economy: 100, business: 0, first: 0 });

			await fireEvent.input(numberBoxes[CLASS_INDEX.economy], { target: { value: '9999' } });

			const config = lastConfig(onChange);
			expect(config.economy).toBe(model().seats);
			expect(usedSeatSlots(config)).toBeLessThanOrEqual(model().seats);
		});

		it('should never fall below zero seats', async () => {
			const { onChange, numberBoxes } = setup({ economy: 100, business: 0, first: 0 });

			await fireEvent.input(numberBoxes[CLASS_INDEX.business], { target: { value: '-5' } });

			expect(lastConfig(onChange)).toEqual({ economy: 100, business: 0, first: 0 });
		});

		it('should account for the slots premium seats consume', async () => {
			const { onChange, numberBoxes } = setup({ economy: 0, business: 0, first: 0 });

			await fireEvent.input(numberBoxes[CLASS_INDEX.first], { target: { value: '9999' } });

			expect(lastConfig(onChange).first).toBe(model().seats / 4);
		});

		it('should leave room for the seats already sold to other classes', async () => {
			const { onChange, numberBoxes } = setup({ economy: 100, business: 0, first: 0 });

			await fireEvent.input(numberBoxes[CLASS_INDEX.business], { target: { value: '9999' } });

			const config = lastConfig(onChange);
			expect(config.business).toBe((model().seats - 100) / 2);
			expect(usedSeatSlots(config)).toBeLessThanOrEqual(model().seats);
		});

		it('should accept a change made with the slider', async () => {
			const { onChange, sliders } = setup({ economy: 100, business: 0, first: 0 });

			await fireEvent.input(sliders[CLASS_INDEX.economy], { target: { value: '60' } });

			expect(lastConfig(onChange)).toEqual({ economy: 60, business: 0, first: 0 });
		});
	});
});
