<script lang="ts">
	import { SEAT_SLOT_COST, totalSeats, usedSeatSlots } from '$data/aircraft';
	import type { AircraftModelDerived, SeatConfig } from '$data/types';

	interface SeatConfiguratorProps {
		model: AircraftModelDerived;
		seats: SeatConfig;
		onChange: (seats: SeatConfig) => void;
	}

	const { model, seats, onChange }: SeatConfiguratorProps = $props();

	const used = $derived(usedSeatSlots(seats));
	const remaining = $derived(model.seats - used);
	const passengers = $derived(totalSeats(seats));

	const CLASS_LABELS = {
		economy: 'Economy',
		business: 'Business',
		first: 'First'
	} as const;

	/** Clamp a class so the cabin never overflows the airframe. */
	const setClass = (passengerClass: keyof SeatConfig, requested: number): void => {
		const cost = SEAT_SLOT_COST[passengerClass];
		const otherSlots = used - seats[passengerClass] * cost;
		const maximum = Math.floor((model.seats - otherSlots) / cost);
		const value = Math.max(0, Math.min(maximum, Math.floor(requested || 0)));

		onChange({ ...seats, [passengerClass]: value });
	};

	const maxFor = (passengerClass: keyof SeatConfig): number => {
		const cost = SEAT_SLOT_COST[passengerClass];
		const otherSlots = used - seats[passengerClass] * cost;
		return Math.floor((model.seats - otherSlots) / cost);
	};
</script>

<div class="e-seats">
	<div class="e-seats__summary">
		<span>
			Cabin slots <strong>{used} / {model.seats}</strong>
		</span>
		<span>
			Seats sold per flight <strong>{passengers}</strong>
		</span>
	</div>

	{#each Object.keys(CLASS_LABELS) as passengerClass (passengerClass)}
		{@const key = passengerClass as keyof SeatConfig}
		<div class="e-seats__row">
			<label class="e-seats__label" for={`seats-${key}`}>
				{CLASS_LABELS[key]}
				<span class="e-seats__cost">{SEAT_SLOT_COST[key]} slot{SEAT_SLOT_COST[key] > 1 ? 's' : ''}/seat</span>
			</label>
			<input
				id={`seats-${key}`}
				class="e-seats__range"
				type="range"
				min="0"
				max={maxFor(key)}
				value={seats[key]}
				oninput={(event) => setClass(key, Number(event.currentTarget.value))}
			/>
			<input
				class="e-seats__number"
				type="number"
				min="0"
				max={maxFor(key)}
				value={seats[key]}
				oninput={(event) => setClass(key, Number(event.currentTarget.value))}
			/>
		</div>
	{/each}

	<p class="e-seats__hint">
		{#if remaining > 0}
			{remaining} slot{remaining === 1 ? '' : 's'} unused — a business seat takes 2, a first seat 4.
		{:else}
			Cabin full.
		{/if}
	</p>
</div>

<style lang="scss">
	.e-seats {
		&__summary {
			display: flex;
			justify-content: space-between;
			margin-bottom: 12px;
			font-size: 12px;
		}

		&__row {
			display: grid;
			grid-template-columns: 120px 1fr 72px;
			align-items: center;
			gap: 12px;
			margin-bottom: 8px;
		}

		&__label {
			display: flex;
			flex-direction: column;
			font-size: 12px;
			font-weight: 600;
		}

		&__cost {
			color: #6b7280;
			font-size: 10px;
			font-weight: 400;
		}

		&__range {
			width: 100%;
		}

		&__number {
			padding: 6px 8px !important;
			font-size: 12px !important;
			text-align: right;
		}

		&__hint {
			margin-top: 8px;
			color: #6b7280;
			font-size: 11px;
		}
	}
</style>
