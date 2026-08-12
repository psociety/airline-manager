<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$lib/paths';
	import { page } from '$app/stores';
	import AirportPicker from '$components/AirportPicker.svelte';
	import AuditPanel from '$components/AuditPanel.svelte';
	import Modal from '$components/Modal.svelte';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import { getAirport } from '$data/airports';
	import type { AircraftModelDerived, GateBlueprint } from '$data/types';
	import { blockHoursExact, getModel } from '$data/aircraft';
	import {
		availableGatesAt,
		companyGatesAt,
		buyAudit,
		companyGates,
		companyRoutes,
		createRoute,
		previewRoute,
		type RoutePreview
	} from '$db/repo';
	import { EMPLOYEES_PER_ROUTE, db, type Company, type OwnedGate, type Route } from '$db/schema';
	import { routeIntel, workingFares, type RouteIntel } from '$engine/audit';
	import { formatHours } from '$engine/clock';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import { ArrowLeftRight, Clock, MapPin, PlusCircle, Route as RouteIcon } from 'lucide-svelte';

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let routes = $state<Route[]>([]);
	let gates = $state<OwnedGate[]>([]);
	let departuresByRoute = $state(new Map<number, number>());
	let fleetModels = $state<AircraftModelDerived[]>([]);

	/** Stands at the chosen destination airport that this airline already holds. */
	const ownedKeys = $derived(new Set(gates.map((gate) => gate.key)));

	/** The airport the chosen origin gate sits at, so it cannot also be the destination. */
	const originIata = $derived(
		gates.find((gate) => gate.key === fromGateKey)?.airportIata ?? null
	);

	let creating = $state(false);
	let fromGateKey = $state<string | null>(null);
	let airportIata = $state('');
	let destinationGates = $state<GateBlueprint[]>([]);
	let toGateKey = $state<string | null>(null);
	let preview = $state<RoutePreview | null>(null);
	let intel = $state<RouteIntel | null>(null);
	let previewError = $state('');
	let submitting = $state(false);
	let auditing = $state(false);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;
			routes = await companyRoutes(found.id);
			gates = await companyGates(found.id);
			fromGateKey ??= gates[0]?.key ?? null;

			const entries = await db.schedule_entries.where('companyId').equals(found.id).toArray();
			const counts = new Map<number, number>();
			for (const entry of entries) counts.set(entry.routeId, (counts.get(entry.routeId) ?? 0) + 1);
			departuresByRoute = counts;

			const aircraft = await db.aircraft.where('companyId').equals(found.id).toArray();
			fleetModels = aircraft.map((item) => getModel(item.modelId));
		})();
	});

	/**
	 * Any gate anywhere can be the destination, even one we do not own yet — buying
	 * it is folded into the route's set-up cost.
	 */
	$effect(() => {
		if (!airportIata || !company) {
			destinationGates = [];
			toGateKey = null;
			return;
		}

		const currentCompanyId = company.id;
		void (async () => {
			const [free, mine] = await Promise.all([
				availableGatesAt(airportIata),
				companyGatesAt(currentCompanyId, airportIata)
			]);

			// Stands we already hold come first: reusing one costs nothing.
			destinationGates = [...mine, ...free];
			toGateKey = destinationGates[0]?.key ?? null;
		})();
	});

	$effect(() => {
		const currentCompany = company;
		const from = fromGateKey;
		const to = toGateKey;

		if (!currentCompany || from === null || to === null) {
			preview = null;
			intel = null;
			return;
		}

		void (async () => {
			try {
				const result = await previewRoute(currentCompany.id, from, to);
				previewError = '';
				preview = result;
				intel = await routeIntel(
					currentCompany.id,
					result.fromIata,
					result.toIata,
					result.distanceKm
				);
			} catch (error) {
				previewError = error instanceof Error ? error.message : 'Route not possible';
				preview = null;
				intel = null;
			}
		})();
	});

	const buyAuditNow = async (): Promise<void> => {
		if (!company || !intel) return;
		auditing = true;

		const currentCompanyId = company.id;
		const { pairKey, auditCost: cost } = intel;
		await game.act(() => buyAudit(currentCompanyId, pairKey, cost), 'Audit delivered');

		if (preview) {
			intel = await routeIntel(currentCompanyId, preview.fromIata, preview.toIata, preview.distanceKm);
		}
		auditing = false;
	};

	const confirmRoute = async (): Promise<void> => {
		if (!company || !preview || !intel) return;
		submitting = true;

		// Opening fares come from the audit when it was paid for, and from the fuzzed
		// estimate when it was not, so an unaudited route never reveals the exact figure.
		const currentCompanyId = company.id;
		const created = await game.act(
			() => createRoute(currentCompanyId, preview!.fromGateId, preview!.toGateId, workingFares(intel!)),
			`Route ${preview.fromIata} ⇄ ${preview.toIata} opened`
		);

		submitting = false;
		if (created) {
			creating = false;
			await goto(`${base}/${slug}/routes/${created.id}`);
		}
	};

	/** Fastest aircraft we own that can actually fly the leg, for the time estimate. */
	const estimateBlockHours = (distance: number): number | null => {
		let best: number | null = null;
		for (const model of fleetModels) {
			if (model.range < distance) continue;
			const hours = blockHoursExact(model, distance);
			if (best === null || hours < best) best = hours;
		}
		return best;
	};
</script>

<PageHeader title="ROUTES" subtitle="{routes.length} routes · {EMPLOYEES_PER_ROUTE} staff each">
	{#snippet actions()}
		<button
			class="e-button e-button--primary"
			type="button"
			disabled={gates.length === 0}
			onclick={() => (creating = true)}
		>
			<PlusCircle size={16} /> Set up a route
		</button>
	{/snippet}
</PageHeader>

{#if gates.length === 0}
	<div class="e-panel e-empty">
		<div class="e-empty__title">Buy a gate first</div>
		<p>A route starts at a gate you own.</p>
		<p class="e-routes__cta"><a class="e-button" href={`${base}/${slug}/gates`}>Go to gates</a></p>
	</div>
{:else if routes.length === 0}
	<div class="e-panel e-empty">
		<div class="e-empty__title">No routes yet</div>
		<p>Pick a starting gate, choose any destination in the world, and check the demand.</p>
	</div>
{:else}
	<div class="e-cards-grid e-cards-grid--wide">
		{#each routes as route (route.id)}
			{@const from = getAirport(route.fromIata)}
			{@const to = getAirport(route.toIata)}
			{@const departures = departuresByRoute.get(route.id) ?? 0}
			<a class="e-unit-card e-unit-card--clickable" href={`${base}/${slug}/routes/${route.id}`}>
				<div class="e-unit-card__status e-status--in-use">
					<RouteIcon size={14} /> {departures} departures / week
				</div>
				<div class="e-unit-card__id">
					{route.fromIata} <ArrowLeftRight size={16} /> {route.toIata}
				</div>
				<div class="e-unit-card__sub">{from.city} ⇄ {to.city}</div>
				<div class="e-unit-card__location">
					<MapPin size={12} />
					{route.distanceKm.toLocaleString('de-DE')} km
				</div>
				<div class="e-routes__prices">
					<span>Eco {route.prices.economy.toLocaleString('de-DE')} €</span>
					<span>Bus {route.prices.business.toLocaleString('de-DE')} €</span>
					<span>1st {route.prices.first.toLocaleString('de-DE')} €</span>
				</div>
				{#if departures === 0}
					<div class="e-tag e-tag--yellow">Not scheduled yet</div>
				{/if}
			</a>
		{/each}
	</div>
{/if}

{#if creating && company}
	<Modal title="Set up a route" wide onClose={() => (creating = false)}>
		<div class="e-route-wizard">
			<div>
				<div class="e-field">
					<label class="e-field__label" for="route-from">Starting gate (must be yours)</label>
					<select id="route-from" bind:value={fromGateKey}>
						{#each gates as gate (gate.key)}
							<option value={gate.key}>
								{gate.airportIata} · {gate.number} (max category {gate.maxCategory})
							</option>
						{/each}
					</select>
				</div>

			<AirportPicker
					label="Destination airport"
					value={airportIata || null}
					disabledCodes={originIata ? [originIata] : []}
					onSelect={(code) => (airportIata = code ?? '')}
				/>

				{#if airportIata}
					<div class="e-field">
						<label class="e-field__label" for="route-gate">Destination gate</label>
						<select id="route-gate" bind:value={toGateKey}>
							{#each destinationGates as gate (gate.key)}
								<option value={gate.key}>
									Gate {gate.number} · max category {gate.maxCategory} ·
									{ownedKeys.has(gate.key)
										? 'already yours'
										: `${gate.price.toLocaleString('de-DE')} €`}
								</option>
							{/each}
						</select>
						<span class="e-field__hint">
							You may pick a gate you do not own yet — its price is added to the set-up cost. The
							route is then flown in both directions.
						</span>
					</div>
				{/if}

				{#if previewError}
					<p class="e-route-wizard__error">{previewError}</p>
				{/if}

				{#if preview}
					<div class="e-kv">
						<span class="e-kv__key">Distance</span>
						<span class="e-kv__value">{preview.distanceKm.toLocaleString('de-DE')} km</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Set-up cost</span>
						<span class="e-kv__value">
							{#if preview.setupCost === 0}
								Free — you own the gate
							{:else}
								<Money amount={preview.setupCost} />
							{/if}
						</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Staff added</span>
						<span class="e-kv__value">
							{EMPLOYEES_PER_ROUTE}{preview.destinationGateOwned ? '' : ' + 10 for the gate'}
						</span>
					</div>
					{#if estimateBlockHours(preview.distanceKm) !== null}
						<div class="e-kv">
							<span class="e-kv__key"><Clock size={12} /> Block time (fastest of your fleet)</span>
							<span class="e-kv__value">
								{formatHours(estimateBlockHours(preview.distanceKm) ?? 0)}
							</span>
						</div>
					{:else if fleetModels.length > 0}
						<div class="e-kv">
							<span class="e-kv__key">Block time</span>
							<span class="e-kv__value">No aircraft in your fleet can reach it</span>
						</div>
					{/if}
					{#if preview.alreadyOperated}
						<p class="e-route-wizard__error">You already operate this route.</p>
					{/if}
				{/if}
			</div>

			<div>
				{#if intel}
					<AuditPanel
						{intel}
						buying={auditing}
						canAfford={company.cash >= intel.auditCost}
						onBuy={buyAuditNow}
						showEstimate={false}
					/>
				{:else}
					<p class="e-route-wizard__hint">
						Choose a destination to see distance, cost and market intelligence.
					</p>
				{/if}
			</div>
		</div>

		{#snippet footer()}
			<button class="e-button" type="button" onclick={() => (creating = false)}>Cancel</button>
			<button
				class="e-button e-button--primary"
				type="button"
				disabled={submitting ||
					!preview ||
					preview.alreadyOperated ||
					(company?.cash ?? 0) < (preview?.setupCost ?? 0)}
				onclick={confirmRoute}
			>
				{submitting ? 'Opening…' : 'Open route'}
			</button>
		{/snippet}
	</Modal>
{/if}

<style lang="scss">
	.e-routes__prices {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		color: #6b7280;
		font-size: 11px;
		font-weight: 600;
	}

	.e-routes__cta {
		margin-top: 16px;
	}

	.e-route-wizard {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 24px;

		&__error {
			padding: 8px 10px;
			color: #7f1d1d;
			font-size: 11px;
			font-weight: 600;
			background: rgba(255, 59, 48, 0.1);
			border-radius: 6px;
		}

		&__hint {
			color: #6b7280;
			font-size: 12px;
		}
	}

	.e-unit-card__id {
		display: flex;
		align-items: center;
		gap: 6px;
	}
</style>
