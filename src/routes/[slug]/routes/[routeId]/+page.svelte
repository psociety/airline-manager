<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import AuditPanel from '$components/AuditPanel.svelte';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import { blockHoursExact, getModel } from '$data/aircraft';
	import { getAirport } from '$data/airports';
	import { GATE_RATINGS, gateBlueprint } from '$data/gates';
	import type { ClassAmounts, PassengerClass } from '$data/types';
	import { buyAudit, deleteRoute, updateCargoRate, updateRoutePrices } from '$db/repo';
	import { db, type Company, type Flight, type Route } from '$db/schema';
	import { routeIntel, workingFares, type RouteIntel } from '$engine/audit';
	import { formatDateTime, formatHours } from '$engine/clock';
	import { idealCargoRate, loadFactorForPrice, passengersForFlight } from '$engine/demand';
	import { airportTaxFor, fuelCostFor, ticketRevenue } from '$engine/economy';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import { ArrowLeft, Package, Plane, Tag, Trash2, TrendingUp } from 'lucide-svelte';

	const slug = $derived($page.params.slug ?? '');
	const routeId = $derived(Number($page.params.routeId));

	let company = $state<Company | null>(null);
	let route = $state<Route | null>(null);
	let intel = $state<RouteIntel | null>(null);
	let prices = $state<ClassAmounts>({ economy: 0, business: 0, first: 0 });
	let cargoRate = $state(0);
	let assigned = $state<{ id: number; name: string; modelId: number; seats: ClassAmounts }[]>([]);
	let weeklyDepartures = $state(0);
	let recentFlights = $state<Flight[]>([]);
	let fuelPrice = $state(0.85);
	let dirty = $state(false);
	let saving = $state(false);
	let auditing = $state(false);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;
		const currentRouteId = routeId;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;

			const loaded = await db.routes.get(currentRouteId);
			if (!loaded || loaded.companyId !== found.id) {
				route = null;
				return;
			}

			route = loaded;
			if (!dirty) {
				prices = { ...loaded.prices };
				cargoRate = loaded.cargoRatePerTonne;
			}
			intel = await routeIntel(found.id, loaded.fromIata, loaded.toIata, loaded.distanceKm);

			const entries = await db.schedule_entries.where('routeId').equals(currentRouteId).toArray();
			weeklyDepartures = entries.length;

			const aircraftIds = [...new Set(entries.map((entry) => entry.aircraftId))];
			const aircraft = await Promise.all(aircraftIds.map((id) => db.aircraft.get(id)));
			assigned = aircraft
				.filter((item) => item !== undefined)
				.map((item) => ({
					id: item!.id,
					name: item!.name,
					modelId: item!.modelId,
					seats: item!.seats
				}));

			const flights = await db.flights.where('routeId').equals(currentRouteId).toArray();
			recentFlights = flights.sort((left, right) => right.departAt - left.departAt).slice(0, 12);

			fuelPrice = (await db.game_state.get(1))?.fuelPricePerLitre ?? 0.85;
		})();
	});

	/**
	 * What the fill indicator and the "use these fares" button work from. Never the
	 * exact ideal fare unless the audit was paid for, otherwise a player could read
	 * the audit's value straight off the screen.
	 */
	const referenceFares = $derived(intel ? workingFares(intel) : null);

	const CLASSES: { key: PassengerClass; label: string }[] = [
		{ key: 'economy', label: 'Economy' },
		{ key: 'business', label: 'Business' },
		{ key: 'first', label: 'First' }
	];

	/** Seats this route offers per day across everything scheduled on it. */
	const seatsPerDeparture = $derived(
		assigned.reduce(
			(sum, aircraft) => ({
				economy: sum.economy + aircraft.seats.economy,
				business: sum.business + aircraft.seats.business,
				first: sum.first + aircraft.seats.first
			}),
			{ economy: 0, business: 0, first: 0 } as ClassAmounts
		)
	);

	const dailyDepartures = $derived(Math.max(weeklyDepartures / 7, 0));

	/**
	 * Projected load for a single departure at the current fares, using the same
	 * model the simulation runs — so the preview is honest.
	 */
	const projection = $derived.by(() => {
		if (!intel || assigned.length === 0 || weeklyDepartures === 0) return null;
		// Projecting loads means using the true demand curve, which is exactly what the
		// audit sells. Unaudited routes learn from what their flights actually carry.
		if (!intel.audited) return null;

		const perDeparture: ClassAmounts = {
			economy: Math.round(seatsPerDeparture.economy / assigned.length),
			business: Math.round(seatsPerDeparture.business / assigned.length),
			first: Math.round(seatsPerDeparture.first / assigned.length)
		};

		const pax = passengersForFlight({
			demand: intel.demand,
			prices,
			seats: perDeparture,
			flightsPerDay: Math.max(1, dailyDepartures),
			competitors: intel.competitors.map((rival) => ({
				companyId: rival.companyId,
				companyName: rival.companyName,
				seatsPerDay: rival.seatsPerDay,
				prices: rival.prices
			}))
		});

		const model = getModel(assigned[0].modelId);
		const passengers = pax.economy + pax.business + pax.first;
		const revenue = ticketRevenue(pax, prices);
		const fuel = fuelCostFor(model, route?.distanceKm ?? 0, fuelPrice);
		const departGate = route ? gateBlueprint(route.fromGateId) : null;
		const tax = airportTaxFor(
			route?.fromIata ?? 'ATL',
			model,
			passengers,
			departGate?.maxCategory ?? GATE_RATINGS[GATE_RATINGS.length - 1]
		);

		return {
			pax,
			seats: perDeparture,
			passengers,
			revenue,
			fuel,
			tax,
			profit: revenue - fuel - tax,
			blockHours: blockHoursExact(model, route?.distanceKm ?? 0)
		};
	});

	/** Hold space the freighters on this route offer per departure. */
	const cargoCapacity = $derived(
		assigned
			.filter((aircraft) => getModel(aircraft.modelId).kind === 'cargo')
			.reduce((sum, aircraft) => sum + getModel(aircraft.modelId).payload, 0)
	);

	/** As with fares, an unaudited route only ever sees the fuzzed midpoint. */
	const referenceCargoRate = $derived.by(() => {
		if (!intel) return 0;
		return intel.audited
			? intel.cargo.idealRatePerTonne
			: Math.round((intel.cargoRange.low + intel.cargoRange.high) / 2) > 0
				? idealCargoRate(route?.distanceKm ?? 0)
				: 0;
	});

	const cargoLoad = $derived(loadFactorForPrice(cargoRate, referenceCargoRate || cargoRate || 1));

	const setCargoRate = (value: number): void => {
		cargoRate = Math.max(0, Math.round(value || 0));
		dirty = true;
	};

	const setPrice = (passengerClass: PassengerClass, value: number): void => {
		prices = { ...prices, [passengerClass]: Math.max(0, Math.round(value || 0)) };
		dirty = true;
	};

	const applyIdeal = (): void => {
		if (!referenceFares) return;
		prices = { ...referenceFares };
		if (referenceCargoRate > 0) cargoRate = referenceCargoRate;
		dirty = true;
	};

	const save = async (): Promise<void> => {
		if (!route) return;
		saving = true;
		await game.act(async () => {
			await updateRoutePrices(route!.id, prices);
			await updateCargoRate(route!.id, cargoRate);
		}, 'Fares updated');
		dirty = false;
		saving = false;
	};

	const buyAuditNow = async (): Promise<void> => {
		if (!company || !intel || !route) return;
		auditing = true;

		const currentCompanyId = company.id;
		await game.act(
			() => buyAudit(currentCompanyId, intel!.pairKey, intel!.auditCost),
			'Audit delivered'
		);
		intel = await routeIntel(currentCompanyId, route.fromIata, route.toIata, route.distanceKm);
		auditing = false;
	};

	const removeRoute = async (): Promise<void> => {
		if (!route) return;
		if (!confirm('Close this route and drop it from every schedule?')) return;

		await game.act(() => deleteRoute(route!.id), 'Route closed');
		await goto(`/${slug}/routes`);
	};
</script>

{#if route && intel}
	{@const from = getAirport(route.fromIata)}
	{@const to = getAirport(route.toIata)}

	<PageHeader
		title="{route.fromIata} ⇄ {route.toIata}"
		subtitle="{from.city} ⇄ {to.city} · {route.distanceKm.toLocaleString('de-DE')} km · {weeklyDepartures} departures/week"
	>
		{#snippet actions()}
			<a class="e-button e-button--ghost e-button--small" href={`/${slug}/routes`}>
				<ArrowLeft size={14} /> All routes
			</a>
			<button class="e-button e-button--small" type="button" onclick={removeRoute}>
				<Trash2 size={14} /> Close route
			</button>
		{/snippet}
	</PageHeader>

	<div class="e-pricing">
		<div class="e-panel">
			<h3 class="e-panel__title"><Tag size={14} /> Ticket prices</h3>

			{#each CLASSES as passengerClass (passengerClass.key)}
				{@const ideal = referenceFares?.[passengerClass.key] ?? 0}
				{@const current = prices[passengerClass.key]}
				{@const load = loadFactorForPrice(current, ideal)}
				<div class="e-pricing__row">
					<label class="e-pricing__label" for={`price-${passengerClass.key}`}>
						{passengerClass.label}
						<span class="e-pricing__seats">
							{seatsPerDeparture[passengerClass.key]} seats/departure
						</span>
					</label>
					<input
						id={`price-${passengerClass.key}`}
						class="e-pricing__input"
						type="number"
						min="0"
						step="5"
						value={current}
						oninput={(event) => setPrice(passengerClass.key, Number(event.currentTarget.value))}
					/>
					<input
						class="e-pricing__range"
						type="range"
						min="0"
						max={Math.round(ideal * 2.5)}
						step="5"
						value={current}
						oninput={(event) => setPrice(passengerClass.key, Number(event.currentTarget.value))}
					/>
					<span
						class="e-pricing__load"
						class:e-pricing__load--good={load >= 0.85}
						class:e-pricing__load--poor={load < 0.5}
						title={intel.audited
							? 'Expected share of seats sold at this fare'
							: 'Rough guess only — this market has not been audited'}
					>
						{Math.round(load * 100)}% fill{intel.audited ? '' : '?'}
					</span>
				</div>
			{/each}

			<h4 class="e-pricing__subtitle"><Package size={12} /> Freight rate</h4>
			<div class="e-pricing__row">
				<label class="e-pricing__label" for="cargo-rate">
					Per tonne
					<span class="e-pricing__seats">{cargoCapacity} t offered per departure</span>
				</label>
				<input
					id="cargo-rate"
					class="e-pricing__input"
					type="number"
					min="0"
					step="10"
					value={cargoRate}
					oninput={(event) => setCargoRate(Number(event.currentTarget.value))}
				/>
				<input
					class="e-pricing__range"
					type="range"
					min="0"
					max={Math.round((referenceCargoRate || 1) * 2.5)}
					step="10"
					value={cargoRate}
					oninput={(event) => setCargoRate(Number(event.currentTarget.value))}
				/>
				<span
					class="e-pricing__load"
					class:e-pricing__load--good={cargoLoad >= 0.85}
					class:e-pricing__load--poor={cargoLoad < 0.5}
				>
					{Math.round(cargoLoad * 100)}% fill{intel.audited ? '' : '?'}
				</span>
			</div>
			{#if cargoCapacity === 0}
				<p class="e-pricing__note">
					No freighter is scheduled here, so the rate earns nothing until one is. Passenger
					aircraft cannot carry freight.
				</p>
			{/if}

			<div class="e-pricing__actions">
				<button class="e-button e-button--small" type="button" onclick={applyIdeal}>
					{intel.audited ? 'Use audited ideal fares' : 'Use estimated fares'}
				</button>
				<button
					class="e-button e-button--primary e-button--small"
					type="button"
					disabled={!dirty || saving}
					onclick={save}
				>
					{saving ? 'Saving…' : dirty ? 'Save fares' : 'Saved'}
				</button>
			</div>

			{#if projection}
				<h4 class="e-pricing__subtitle"><TrendingUp size={12} /> Projected per departure</h4>
				<div class="e-kv">
					<span class="e-kv__key">Passengers</span>
					<span class="e-kv__value">
						{projection.passengers} of {projection.seats.economy +
							projection.seats.business +
							projection.seats.first} seats
					</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Ticket revenue</span>
					<span class="e-kv__value"><Money amount={projection.revenue} /></span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Fuel</span>
					<span class="e-kv__value"><Money amount={-projection.fuel} /></span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Departure charges ({route.fromIata})</span>
					<span class="e-kv__value"><Money amount={-projection.tax} /></span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Result per departure</span>
					<span class="e-kv__value">
						<Money amount={projection.profit} colour signed />
					</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Block time</span>
					<span class="e-kv__value">{formatHours(projection.blockHours)}</span>
				</div>
				<p class="e-pricing__note">
					Wages, leases and maintenance are charged separately — this is the direct result of one
					departure. The route is flown both ways, and each departure pays the charges of the
					airport it leaves from.
				</p>
			{:else if !intel.audited}
				<p class="e-pricing__note">
					Loads and revenue cannot be projected on an unaudited route — buy the audit for the exact
					demand, or read <strong>recent departures</strong> below to see what your flights are
					really carrying.
				</p>
			{:else}
				<p class="e-pricing__note">
					Nothing is scheduled on this route yet, so there is no load to project.
					<a href={`/${slug}/schedule`}>Open the scheduler</a> to assign an aircraft.
				</p>
			{/if}
		</div>

		<div class="e-panel">
			<AuditPanel
				{intel}
				buying={auditing}
				canAfford={(company?.cash ?? 0) >= intel.auditCost}
				onBuy={buyAuditNow}
				showEstimate
			/>
		</div>
	</div>

	<div class="e-panel e-pricing__history">
		<h3 class="e-panel__title"><Plane size={14} /> Recent departures</h3>
		{#if recentFlights.length === 0}
			<p class="e-pricing__note">No flights operated yet.</p>
		{:else}
			<div class="e-table-wrapper">
				<table class="e-table">
					<thead>
						<tr>
							<th>Departed</th>
							<th class="e-table__num">Eco</th>
							<th class="e-table__num">Bus</th>
						<th class="e-table__num">1st</th>
							<th class="e-table__num">Freight</th>
							<th class="e-table__num">Revenue</th>
							<th class="e-table__num">Fuel + tax</th>
							<th>Status</th>
						</tr>
					</thead>
					<tbody>
						{#each recentFlights as flight (flight.id)}
							<tr>
								<td>{formatDateTime(flight.departAt)}</td>
								<td class="e-table__num">{flight.pax.economy}</td>
								<td class="e-table__num">{flight.pax.business}</td>
							<td class="e-table__num">{flight.pax.first}</td>
								<td class="e-table__num">
									{flight.cargoTonnes > 0 ? `${flight.cargoTonnes} t` : '—'}
								</td>
								<td class="e-table__num"><Money amount={flight.revenue} compact /></td>
								<td class="e-table__num">
									<Money amount={-(flight.fuelCost + flight.taxCost)} compact />
								</td>
								<td>
									{#if flight.status === 'accident'}
										<span class="e-tag e-tag--red">Accident</span>
									{:else if flight.status === 'flying'}
										<span class="e-tag e-tag--teal">In flight</span>
									{:else}
										<span class="e-tag">Completed</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
{:else}
	<div class="e-panel e-empty">
		<div class="e-empty__title">Route not found</div>
		<p>It may have been closed.</p>
		<p><a class="e-button" href={`/${slug}/routes`}>Back to routes</a></p>
	</div>
{/if}

<style lang="scss">
	.e-pricing {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
		gap: 20px;

		&__row {
			display: grid;
			grid-template-columns: 130px 90px 1fr 70px;
			align-items: center;
			gap: 10px;
			margin-bottom: 10px;
		}

		&__label {
			display: flex;
			flex-direction: column;
			font-size: 12px;
			font-weight: 600;
		}

		&__seats {
			color: #6b7280;
			font-size: 10px;
			font-weight: 400;
		}

		&__input {
			padding: 6px 8px !important;
			font-size: 12px !important;
			text-align: right;
		}

		&__range {
			width: 100%;
		}

		&__load {
			color: #6b7280;
			font-size: 11px;
			font-weight: 700;
			text-align: right;

			&--good {
				color: #059669;
			}

			&--poor {
				color: #ff3b30;
			}
		}

		&__actions {
			display: flex;
			justify-content: space-between;
			gap: 8px;
			margin: 16px 0;
		}

		&__subtitle {
			display: flex;
			align-items: center;
			gap: 4px;
			margin: 16px 0 4px;
			color: #6b7280;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.5px;
			text-transform: uppercase;
		}

		&__note {
			margin-top: 10px;
			color: #6b7280;
			font-size: 11px;
			line-height: 1.5;
		}

		&__history {
			margin-top: 20px;
		}
	}
</style>
