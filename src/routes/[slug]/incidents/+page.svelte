<script lang="ts">
	import { page } from '$app/stores';
	import Modal from '$components/Modal.svelte';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { fightIncident, incidentHistory, pendingIncidents, settleIncident } from '$db/repo';
	import type { Company, Incident } from '$db/schema';
	import { formatDateTime } from '$engine/clock';
	import { formatCompactMoney } from '$engine/economy';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import { AlertTriangle, Gavel, HandCoins, ShieldCheck } from 'lucide-svelte';

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let pending = $state<Incident[]>([]);
	let history = $state<Incident[]>([]);
	let resolving = $state<Incident | null>(null);
	let submitting = $state(false);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;
			pending = await pendingIncidents(found.id);
			history = await incidentHistory(found.id);
		})();
	});

	const totalPaid = $derived(
		history.reduce((sum, incident) => sum + (incident.finalAmount ?? 0), 0)
	);
	const wonCount = $derived(history.filter((incident) => incident.finalAmount === 0).length);

	const settle = async (): Promise<void> => {
		if (!resolving) return;
		submitting = true;

		const incidentId = resolving.id;
		await game.act(() => settleIncident(incidentId), 'Indemnity paid — the claim is closed');

		submitting = false;
		resolving = null;
	};

	const fight = async (): Promise<void> => {
		if (!resolving) return;
		submitting = true;

		const incidentId = resolving.id;
		const outcome = await game.act(() => fightIncident(incidentId));
		if (outcome) {
			game.toast(
				outcome.won
					? 'Case won — the airline pays nothing'
					: `Case lost — ${Math.round(outcome.amount).toLocaleString('de-DE')} € in damages`,
				outcome.won ? 'info' : 'error'
			);
		}

		submitting = false;
		resolving = null;
	};
</script>

<PageHeader title="INCIDENTS" subtitle="Accidents, claims and their outcomes">
	{#snippet stats()}
		<StatBox icon={AlertTriangle} value={String(pending.length)} label="Open claims" />
		<StatBox
			icon={HandCoins}
			value={formatCompactMoney(totalPaid)}
			label="Damages paid"
		/>
		<StatBox icon={ShieldCheck} value={String(wonCount)} label="Cases won" />
	{/snippet}
</PageHeader>

{#if pending.length > 0}
	<h3 class="e-incidents__heading">Open claims</h3>
	<div class="e-cards-grid e-cards-grid--wide">
		{#each pending as incident (incident.id)}
			<div class="e-unit-card">
				<div class="e-unit-card__status e-status--error">
					<AlertTriangle size={14} /> Accident claim
				</div>
				<div class="e-unit-card__id"><Money amount={incident.baseAmount} compact /></div>
				<div class="e-unit-card__sub">{incident.aircraftName}</div>
				<div class="e-unit-card__location">
					{incident.passengers} passengers on board · {formatDateTime(incident.at)}
				</div>
				<p class="e-incidents__text">
					The airframe was overdue for maintenance. Settle now, or take your chances in court: a
					loss costs the damages plus 10%–100% on top.
				</p>
				<button
					class="e-button e-button--primary e-button--block"
					type="button"
					onclick={() => (resolving = incident)}
				>
					Resolve claim
				</button>
			</div>
		{/each}
	</div>
{:else}
	<div class="e-panel e-empty">
		<div class="e-empty__title">No open claims</div>
		<p>
			Accidents only happen to aircraft flown past their service interval. Keep the fleet
			maintained and this page stays empty.
		</p>
	</div>
{/if}

{#if history.length > 0}
	<h3 class="e-incidents__heading">Closed cases</h3>
	<div class="e-table-wrapper">
		<table class="e-table">
			<thead>
				<tr>
					<th>Date</th>
					<th>Aircraft</th>
					<th class="e-table__num">Passengers</th>
					<th class="e-table__num">Claimed</th>
					<th class="e-table__num">Paid</th>
					<th>Outcome</th>
				</tr>
			</thead>
			<tbody>
				{#each history as incident (incident.id)}
					<tr>
						<td>{formatDateTime(incident.at)}</td>
						<td>{incident.aircraftName}</td>
						<td class="e-table__num">{incident.passengers}</td>
						<td class="e-table__num"><Money amount={incident.baseAmount} compact /></td>
						<td class="e-table__num">
							<Money amount={incident.finalAmount ?? 0} compact />
						</td>
						<td>
							{#if incident.finalAmount === 0}
								<span class="e-tag e-tag--teal">{incident.outcome}</span>
							{:else}
								<span class="e-tag e-tag--red">{incident.outcome}</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

{#if resolving}
	<Modal title="Resolve the claim" onClose={() => (resolving = null)}>
		<div class="e-kv">
			<span class="e-kv__key">Aircraft</span>
			<span class="e-kv__value">{resolving.aircraftName}</span>
		</div>
		<div class="e-kv">
			<span class="e-kv__key">Passengers affected</span>
			<span class="e-kv__value">{resolving.passengers}</span>
		</div>
		<div class="e-kv">
			<span class="e-kv__key">Damages claimed</span>
			<span class="e-kv__value"><Money amount={resolving.baseAmount} /></span>
		</div>
		<div class="e-kv">
			<span class="e-kv__key">Worst case in court</span>
			<span class="e-kv__value"><Money amount={resolving.baseAmount * 2} /></span>
		</div>
		{#if company}
			<div class="e-kv">
				<span class="e-kv__key">Cash available</span>
				<span class="e-kv__value"><Money amount={company.cash} /></span>
			</div>
		{/if}

		<p class="e-incidents__text">
			Fighting is an even coin flip. Win and you pay nothing; lose and you pay the damages plus a
			random 10%–100% penalty. Either way the aircraft spends 48 hours in repairs.
		</p>

		{#snippet footer()}
			<button class="e-button" type="button" onclick={() => (resolving = null)}>Later</button>
			<button class="e-button" type="button" disabled={submitting} onclick={fight}>
				<Gavel size={14} /> Fight the lawsuit
			</button>
			<button
				class="e-button e-button--primary"
				type="button"
				disabled={submitting}
				onclick={settle}
			>
				<HandCoins size={14} /> Pay indemnity
			</button>
		{/snippet}
	</Modal>
{/if}

<style lang="scss">
	.e-incidents__heading {
		margin: 8px 0 12px;
		color: #6b7280;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}

	.e-incidents__text {
		color: #6b7280;
		font-size: 11px;
		line-height: 1.5;
	}
</style>
