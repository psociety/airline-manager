<script lang="ts">
	import { page } from '$app/stores';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { recentTransactions } from '$db/repo';
	import type { Company, TransactionRecord } from '$db/schema';
	import { dayKey, formatClock } from '$engine/clock';
	import { formatCompactMoney } from '$engine/economy';
	import { CATEGORY_LABELS, groupByDay, summariseLedger } from '$engine/ledger';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import { Coins, Landmark, TrendingDown, TrendingUp, Wallet } from 'lucide-svelte';

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let records = $state<TransactionRecord[]>([]);
	let expandedDay = $state<number | null>(null);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;
			records = await recentTransactions(found.id, 800);
		})();
	});

	const days = $derived(groupByDay(records));
	const totals = $derived(summariseLedger(records));
</script>

<PageHeader title="ACCOUNTING" subtitle="Every euro in and out, day by day">
	{#snippet stats()}
		<StatBox icon={TrendingUp} value={formatCompactMoney(totals.income)} label="Total income" />
		<StatBox
			icon={TrendingDown}
			value={formatCompactMoney(totals.expense)}
			label="Total expenses"
		/>
		<StatBox
			icon={Coins}
			value={formatCompactMoney(totals.operatingResult)}
			label="Operating result"
		/>
		<StatBox
			icon={Wallet}
			value={formatCompactMoney(totals.netCashMovement)}
			label="Net cash movement"
		/>
	{/snippet}
</PageHeader>

{#if records.length === 0}
	<div class="e-panel e-empty">
		<div class="e-empty__title">The books are empty</div>
		<p>Buy a gate or an aircraft and the ledger starts filling up.</p>
	</div>
{:else}
	{#each days as summary (summary.day)}
		<section class="e-panel e-ledger">
			<button
				class="e-ledger__header"
				type="button"
				onclick={() => (expandedDay = expandedDay === summary.day ? null : summary.day)}
			>
				<span class="e-ledger__date"><Landmark size={14} /> {dayKey(summary.day)}</span>
				<span class="e-ledger__totals">
					<span class="e-money e-money--positive">
						+{Math.round(summary.income).toLocaleString('de-DE')} €
					</span>
					<span class="e-money e-money--negative">
						{Math.round(summary.expense).toLocaleString('de-DE')} €
					</span>
					<strong>
						<Money amount={summary.income + summary.expense} colour signed />
					</strong>
				</span>
			</button>

			<div class="e-ledger__categories">
				{#each summary.byCategory as line (line.category)}
					<span
						class="e-tag"
						class:e-tag--teal={line.amount > 0}
						class:e-tag--red={line.amount < 0}
					>
						{CATEGORY_LABELS[line.category]}
						{Math.round(line.amount / 1000).toLocaleString('de-DE')}k
					</span>
				{/each}
			</div>

			{#if expandedDay === summary.day}
				<div class="e-table-wrapper e-ledger__detail">
					<table class="e-table">
						<thead>
							<tr>
								<th>Time</th>
								<th>Category</th>
								<th>Description</th>
								<th class="e-table__num">Amount</th>
							</tr>
						</thead>
						<tbody>
							{#each summary.records as record (record.id)}
								<tr>
									<td>{formatClock(record.at)}</td>
									<td>{CATEGORY_LABELS[record.category]}</td>
									<td>{record.description}</td>
									<td class="e-table__num"><Money amount={record.amount} colour signed /></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="e-ledger__hint">
					{summary.records.length} entries — click the day to see them
				</p>
			{/if}
		</section>
	{/each}
{/if}

<style lang="scss">
	.e-ledger {
		margin-bottom: 16px;

		&__header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			width: 100%;
			padding: 0;
			background: none;
			border: none;
			cursor: pointer;
		}

		&__date {
			display: flex;
			align-items: center;
			gap: 6px;
			font-size: 14px;
			font-weight: 600;
		}

		&__totals {
			display: flex;
			align-items: center;
			gap: 14px;
			font-size: 12px;
		}

		&__categories {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			margin-top: 12px;
		}

		&__detail {
			margin-top: 12px;
		}

		&__hint {
			margin-top: 10px;
			color: #6b7280;
			font-size: 11px;
		}
	}
</style>
