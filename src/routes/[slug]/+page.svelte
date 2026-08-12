<script lang="ts">
	import { base } from '$lib/paths';
	import { page } from '$app/stores';
	import Countdown from '$components/Countdown.svelte';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import RouteMap from '$components/RouteMap.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { getModel, totalSeats } from '$data/aircraft';
	import { companyRoutes, companyValuation } from '$db/repo';
	import { db, type Aircraft, type Company, type Flight, type Route } from '$db/schema';
	import { dayIndexOf, formatDateTime } from '$engine/clock';
	import { formatCompactMoney } from '$engine/economy';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import {
		Activity,
		BadgeEuro,
		Coins,
		LayoutGrid,
		MapPin,
		Plane,
		TrendingUp,
		Users
	} from 'lucide-svelte';

	type View = 'map' | 'grid';

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let routes = $state<Route[]>([]);
	let rivalRoutes = $state<Route[]>([]);
	let airborne = $state<Flight[]>([]);
	let fleet = $state<Aircraft[]>([]);
	let sharePrice = $state(0);
	let todayIncome = $state(0);
	let todayExpense = $state(0);
	let view = $state<View>('map');

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;

			company = found;
			routes = await companyRoutes(found.id);
			fleet = await db.aircraft.where('companyId').equals(found.id).toArray();
			sharePrice = (await companyValuation(found.id)).sharePrice;

			const allFlying = await db.flights.where('status').equals('flying').toArray();
			airborne = allFlying.filter((flight) => flight.companyId === found.id);

			const everyRoute = await db.routes.toArray();
			rivalRoutes = everyRoute.filter((route) => route.companyId !== found.id);

			const today = dayIndexOf(game.now);
			const records = await db.transaction_records
				.where('[companyId+day]')
				.equals([found.id, today])
				.toArray();

			todayIncome = records
				.filter((record) => record.amount > 0)
				.reduce((sum, record) => sum + record.amount, 0);
			todayExpense = records
				.filter((record) => record.amount < 0)
				.reduce((sum, record) => sum + record.amount, 0);
		})();
	});

	const seatCount = $derived(fleet.reduce((sum, aircraft) => sum + totalSeats(aircraft.seats), 0));
	const inFlight = $derived(fleet.filter((aircraft) => aircraft.status === 'flying').length);
	const idle = $derived(fleet.filter((aircraft) => aircraft.status === 'idle').length);
	const grounded = $derived(
		fleet.filter((aircraft) => aircraft.status === 'grounded' || aircraft.status === 'maintenance')
			.length
	);
	const utilisation = $derived(fleet.length > 0 ? inFlight / fleet.length : 0);
</script>

{#if company}
	<PageHeader title="DASHBOARD" subtitle="{company.name} · {company.icao}">
		{#snippet stats()}
			<StatBox
				icon={Activity}
				value="{Math.round(utilisation * 100)}%"
				label="Fleet in the air"
			/>
			<StatBox icon={Coins} value={formatCompactMoney(todayIncome)} label="Income today" />
			<StatBox
				icon={TrendingUp}
				value={formatCompactMoney(todayExpense)}
				label="Expenses today"
			/>
			<StatBox icon={BadgeEuro} value="{sharePrice.toLocaleString('de-DE')} €" label="Share price" />
		{/snippet}
	</PageHeader>

	<div class="e-view-tabs">
		<button
			class="e-view-tabs__btn"
			class:e-view-tabs__btn--active={view === 'map'}
			type="button"
			onclick={() => (view = 'map')}
		>
			<MapPin size={16} /> Map view
		</button>
		<button
			class="e-view-tabs__btn"
			class:e-view-tabs__btn--active={view === 'grid'}
			type="button"
			onclick={() => (view = 'grid')}
		>
			<LayoutGrid size={16} /> Live flights
		</button>
	</div>

	{#if view === 'map'}
		{#if routes.length === 0}
			<div class="e-panel e-empty">
				<div class="e-empty__title">Nothing on the map yet</div>
				<p>Open a route and schedule it — your aircraft will show up here while they fly.</p>
				<p><a class="e-button e-button--primary" href={`${base}/${slug}/routes`}>Set up a route</a></p>
			</div>
		{:else}
			<RouteMap {routes} flights={airborne} {fleet} {rivalRoutes} colour={company.colour} />
			<div class="e-dashboard__legend">
				<span><span class="e-dashboard__swatch" style:background={company.colour}></span> Your network</span>
				<span><span class="e-dashboard__swatch e-dashboard__swatch--rival"></span> Rival routes</span>
				<span>✈ {airborne.length} aircraft airborne now</span>
			</div>
		{/if}
	{:else if airborne.length === 0}
		<div class="e-panel e-empty">
			<div class="e-empty__title">No aircraft in the air</div>
			<p>Flights appear here as their scheduled departures come round.</p>
		</div>
	{:else}
		<div class="e-cards-grid e-cards-grid--wide">
			{#each airborne as flight (flight.id)}
				{@const aircraft = fleet.find((item) => item.id === flight.aircraftId)}
				{@const progress = Math.max(
					0,
					Math.min(1, (game.now - flight.departAt) / (flight.arriveAt - flight.departAt))
				)}
				<div class="e-unit-card">
					<div class="e-unit-card__status e-status--in-use">
						<Plane size={14} /> In flight · {Math.round(progress * 100)}%
					</div>
					<div class="e-unit-card__id">{flight.fromIata} → {flight.toIata}</div>
					<div class="e-unit-card__sub">
						{aircraft?.name ?? 'Aircraft'}
						{#if aircraft}· {getModel(aircraft.modelId).name}{/if}
					</div>
					<div class="e-unit-card__location">
						<MapPin size={12} /> lands in <Countdown until={flight.arriveAt} doneLabel="moments" />
					</div>
					<div class="e-metric-bar">
						<div class="e-metric-bar__track">
							<div class="e-metric-bar__fill e-metric-bar__fill--green" style:width="{progress * 100}%"></div>
						</div>
					</div>
					<div class="e-unit-card__footer">
						<span class="e-tag">
							{flight.pax.economy + flight.pax.business + flight.pax.first} pax
						</span>
						<span class="e-tag e-tag--teal"><Money amount={flight.revenue} compact /></span>
					</div>
					<div class="e-dashboard__flight-meta">
						Departed {formatDateTime(flight.departAt)}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<div class="e-dashboard__summary">
		<div class="e-panel">
			<h3 class="e-panel__title"><Plane size={14} /> Fleet status</h3>
			<div class="e-kv">
				<span class="e-kv__key">In the air</span><span class="e-kv__value">{inFlight}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Idle</span><span class="e-kv__value">{idle}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Maintenance or grounded</span>
				<span class="e-kv__value">{grounded}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Seats installed</span>
				<span class="e-kv__value">{seatCount.toLocaleString('de-DE')}</span>
			</div>
		</div>

		<div class="e-panel">
			<h3 class="e-panel__title"><Users size={14} /> Company</h3>
			<div class="e-kv">
				<span class="e-kv__key">Run by</span>
				<span class="e-kv__value">
					{(company.ceoHired ?? false)
						? 'Hired CEO'
						: company.controller === 'player'
							? 'You'
							: 'Own management'}
				</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Cash</span>
				<span class="e-kv__value"><Money amount={company.cash} /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">External workers</span>
				<span class="e-kv__value">{company.external_workers.toLocaleString('de-DE')}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Hired workers</span>
				<span class="e-kv__value">{company.hired_workers.toLocaleString('de-DE')}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Routes</span><span class="e-kv__value">{routes.length}</span>
			</div>
		</div>
	</div>
{/if}

<style lang="scss">
	.e-dashboard__legend {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		margin-top: 12px;
		color: #6b7280;
		font-size: 11px;
	}

	.e-dashboard__swatch {
		display: inline-block;
		width: 18px;
		height: 3px;
		margin-right: 4px;
		vertical-align: middle;
		border-radius: 2px;

		&--rival {
			background: #9aa1ae;
		}
	}

	.e-dashboard__flight-meta {
		color: #6b7280;
		font-size: 10px;
	}

	.e-dashboard__summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 20px;
		margin-top: 20px;
	}
</style>
