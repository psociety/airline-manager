<script lang="ts">
	import Money from '$components/Money.svelte';
	import type { RouteIntel } from '$engine/audit';
	import { FileSearch, Lock, Users } from 'lucide-svelte';

	interface AuditPanelProps {
		intel: RouteIntel;
		onBuy?: () => void;
		buying?: boolean;
		canAfford?: boolean;
		/**
		 * Whether the fuzzy figures may be shown at all. Only routes the airline
		 * already operates get an estimate; on a route that has not been opened yet,
		 * nothing about demand or fares is known until the audit is paid for.
		 */
		showEstimate?: boolean;
	}

	const {
		intel,
		onBuy,
		buying = false,
		canAfford = true,
		showEstimate = false
	}: AuditPanelProps = $props();

	const figuresHidden = $derived(!intel.audited && !showEstimate);

	const CLASSES = [
		{ key: 'economy', label: 'Economy' },
		{ key: 'business', label: 'Business' },
		{ key: 'first', label: 'First' }
	] as const;
</script>

<div class="e-audit">
	<header class="e-audit__header">
		<h3 class="e-panel__title">
			{#if intel.audited}
				<FileSearch size={14} /> Market audit
			{:else if figuresHidden}
				<Lock size={14} /> Market unknown
			{:else}
				<Lock size={14} /> Unaudited estimate
			{/if}
		</h3>
		{#if intel.audited}
			<span class="e-tag e-tag--teal">Paid</span>
		{:else if onBuy}
			<button
				class="e-button e-button--primary e-button--small"
				type="button"
				disabled={buying || !canAfford}
				onclick={onBuy}
			>
				{canAfford
					? buying
						? 'Auditing…'
						: 'Audit for '
					: 'Not enough cash'}{#if canAfford && !buying}<Money amount={intel.auditCost} compact />{/if}
			</button>
		{/if}
	</header>

	{#if figuresHidden}
		<div class="e-audit__locked">
			<p>
				Nobody has surveyed this market for you. Daily demand per class and the fare the market
				considers fair stay hidden until you commission the audit.
			</p>
			<p class="e-audit__note">
				Paid once, it stays with this airline for this pair forever — including next time you come
				back to it.
			</p>
		</div>
	{:else}
		<table class="e-table e-audit__table">
			<thead>
				<tr>
					<th>Class</th>
					<th class="e-table__num">Demand / day</th>
					<th class="e-table__num">Ideal fare</th>
				</tr>
			</thead>
			<tbody>
				{#each CLASSES as passengerClass (passengerClass.key)}
					<tr>
						<td>{passengerClass.label}</td>
						{#if intel.audited}
							<td class="e-table__num">
								{intel.demand.dailyDemand[passengerClass.key].toLocaleString('de-DE')}
							</td>
							<td class="e-table__num">
								{intel.demand.idealPrice[passengerClass.key].toLocaleString('de-DE')} €
							</td>
						{:else}
							{@const demandRange = intel.vague.demand[passengerClass.key]}
							{@const priceRange = intel.vague.idealPrice[passengerClass.key]}
							<td class="e-table__num e-audit__vague">
								{demandRange.low}–{demandRange.high}
								<span class="e-audit__label">{demandRange.label}</span>
							</td>
							<td class="e-table__num e-audit__vague">
								{priceRange.low}–{priceRange.high} €
							</td>
						{/if}
					</tr>
				{/each}
				<tr class="e-audit__freight">
					<td>Freight</td>
					{#if intel.audited}
						<td class="e-table__num">{intel.cargo.tonnesPerDay.toLocaleString('de-DE')} t</td>
						<td class="e-table__num">
							{intel.cargo.idealRatePerTonne.toLocaleString('de-DE')} €/t
						</td>
					{:else}
						<td class="e-table__num e-audit__vague">
							{intel.cargoRange.low}–{intel.cargoRange.high} t
							<span class="e-audit__label">{intel.cargoRange.label}</span>
						</td>
						<td class="e-table__num e-audit__vague">—</td>
					{/if}
				</tr>
			</tbody>
		</table>

		{#if !intel.audited}
			<p class="e-audit__note">
				These are rumours from the trade press, based on what your own flights have carried. A paid
				audit reveals the exact daily demand and the fare the market considers fair — once bought,
				it stays available to this airline forever.
			</p>
		{/if}
	{/if}

	<h4 class="e-audit__subtitle"><Users size={12} /> Competition on this pair (live)</h4>
	{#if intel.competitors.length === 0}
		<p class="e-audit__note">Nobody else flies it. All the demand is yours.</p>
	{:else}
		<table class="e-table">
			<thead>
				<tr>
					<th>Airline</th>
					<th class="e-table__num">Flights / week</th>
					<th class="e-table__num">Seats / day</th>
					<th class="e-table__num">Economy fare</th>
				</tr>
			</thead>
			<tbody>
				{#each intel.competitors as rival (rival.companyId)}
					<tr>
						<td>{rival.icao} · {rival.companyName}</td>
						<td class="e-table__num">{rival.weeklyDepartures}</td>
						<td class="e-table__num">
							{(rival.seatsPerDay.economy + rival.seatsPerDay.business + rival.seatsPerDay.first).toLocaleString(
								'de-DE'
							)}
						</td>
						<td class="e-table__num">{rival.prices.economy.toLocaleString('de-DE')} €</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style lang="scss">
	.e-audit {
		&__header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 12px;
		}

		&__table {
			margin-bottom: 8px;
		}

		&__vague {
			color: #6b7280;
		}

		&__freight td {
			border-top: 1px solid #e5e7eb;
		}

		&__label {
			display: block;
			font-size: 10px;
			text-transform: uppercase;
		}

		&__locked {
			padding: 4px 0 8px;
			color: #6b7280;
			font-size: 12px;
			line-height: 1.55;
		}

		&__note {
			margin: 8px 0;
			color: #6b7280;
			font-size: 11px;
			line-height: 1.5;
		}

		&__subtitle {
			display: flex;
			align-items: center;
			gap: 4px;
			margin: 16px 0 8px;
			color: #6b7280;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.5px;
			text-transform: uppercase;
		}
	}
</style>
