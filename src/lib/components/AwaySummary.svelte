<script lang="ts">
	import Modal from '$components/Modal.svelte';
	import { formatDuration } from '$engine/clock';
	import { formatCompactMoney } from '$engine/economy';
	import type { CatchUpSummary } from '$engine/tick';
	import { game } from '$state/game.svelte';

	const { summary }: { summary: CatchUpSummary } = $props();

	const elapsed = $derived(summary.to - summary.from);
</script>

<Modal title="While you were away" onClose={() => game.dismissAwaySummary()}>
	<p class="e-away__intro">
		{formatDuration(elapsed)} of operations were simulated.
	</p>

	<div class="e-kv">
		<span class="e-kv__key">Days closed</span>
		<span class="e-kv__value">{summary.daysProcessed}</span>
	</div>
	<div class="e-kv">
		<span class="e-kv__key">Flights operated</span>
		<span class="e-kv__value">{summary.flightsFlown}</span>
	</div>
	<div class="e-kv">
		<span class="e-kv__key">Aircraft delivered</span>
		<span class="e-kv__value">{summary.deliveries}</span>
	</div>
	<div class="e-kv">
		<span class="e-kv__key">Heavy checks started</span>
		<span class="e-kv__value">{summary.maintenanceStarted}</span>
	</div>
	<div class="e-kv">
		<span class="e-kv__key">Accidents</span>
		<span class="e-kv__value">{summary.accidents}</span>
	</div>

	{#if summary.ceoSharesPaid > 0}
		<div class="e-kv">
			<span class="e-kv__key">CEO fees paid</span>
			<span class="e-kv__value">
				{summary.ceoSharesPaid} share{summary.ceoSharesPaid === 1 ? '' : 's'}
			</span>
		</div>
	{/if}

	{#if summary.bidOutcomes.length > 0}
		<p class="e-away__heading">Takeover offers</p>
		{#each summary.bidOutcomes as outcome (outcome.bidId)}
			<div class="e-kv">
				<span class="e-kv__key">{outcome.targetIcao} · {outcome.targetName}</span>
				<span class="e-kv__value">
					{#if outcome.sharesWon > 0}
						Won {outcome.sharesWon.toLocaleString('de-DE')} for {formatCompactMoney(outcome.spent)}
						{#if outcome.tookControl}· control{/if}
					{:else}
						Lapsed · {formatCompactMoney(outcome.refunded)} returned
					{/if}
				</span>
			</div>
			{#if outcome.defence}
				<p class="e-away__note">{outcome.targetIcao}: {outcome.defence}</p>
			{/if}
		{/each}
	{/if}

	{#if summary.skippedDays > 0}
		<p class="e-away__note">
			{summary.skippedDays} day{summary.skippedDays === 1 ? '' : 's'} beyond the 30-day catch-up
			limit were skipped.
		</p>
	{/if}

	{#snippet footer()}
		<button class="e-button e-button--primary" type="button" onclick={() => game.dismissAwaySummary()}>
			Continue
		</button>
	{/snippet}
</Modal>

<style lang="scss">
	.e-away__intro {
		margin-bottom: 12px;
		font-size: 13px;
	}

	.e-away__note {
		margin-top: 12px;
		color: #6b7280;
		font-size: 11px;
	}

	.e-away__heading {
		margin-top: 16px;
		color: #6b7280;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}
</style>
