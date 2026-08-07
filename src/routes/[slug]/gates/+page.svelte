<script lang="ts">
	import { page } from '$app/stores';
	import AirportPicker from '$components/AirportPicker.svelte';
	import Modal from '$components/Modal.svelte';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { getAirport } from '$data/airports';
	import type { GateBlueprint } from '$data/types';
	import { availableGatesAt, buyGate, companyGates } from '$db/repo';
	import { EMPLOYEES_PER_GATE, db, type Company, type OwnedGate } from '$db/schema';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import { DoorOpen, MapPin, Plane, PlusCircle, Users } from 'lucide-svelte';

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let gates = $state<OwnedGate[]>([]);
	let aircraftByGate = $state(new Map<string, number>());

	let buying = $state(false);
	let airportIata = $state('');
	let candidates = $state<GateBlueprint[]>([]);
	let selectedGateKey = $state<string | null>(null);
	let submitting = $state(false);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;
			gates = await companyGates(found.id);

			const fleet = await db.aircraft.where('companyId').equals(found.id).toArray();
			const counts = new Map<string, number>();
			for (const aircraft of fleet) {
				counts.set(aircraft.homeGateId, (counts.get(aircraft.homeGateId) ?? 0) + 1);
			}
			aircraftByGate = counts;
		})();
	});

	$effect(() => {
		if (!airportIata) {
			candidates = [];
			selectedGateKey = null;
			return;
		}
		void availableGatesAt(airportIata).then((list) => {
			candidates = list;
			selectedGateKey = list[0]?.key ?? null;
		});
	});

	const selectedGate = $derived(candidates.find((gate) => gate.key === selectedGateKey) ?? null);

	const confirmPurchase = async (): Promise<void> => {
		if (!company || selectedGateKey === null) return;
		submitting = true;

		const result = await game.act(
			() => buyGate(company!.id, selectedGateKey!),
			`Gate secured at ${airportIata}`
		);

		submitting = false;
		if (result) {
			buying = false;
			airportIata = '';
		}
	};

	const gatesByAirport = $derived(
		[...gates.reduce((map, gate) => {
			const list = map.get(gate.airportIata) ?? [];
			list.push(gate);
			map.set(gate.airportIata, list);
			return map;
		}, new Map<string, OwnedGate[]>())].sort((left, right) => left[0].localeCompare(right[0]))
	);
</script>

<PageHeader title="GATES" subtitle="{gates.length} stands owned across {gatesByAirport.length} airports">
	{#snippet stats()}
		<StatBox
			icon={Users}
			value={(gates.length * EMPLOYEES_PER_GATE).toLocaleString('de-DE')}
			label="Gate staff"
		/>
	{/snippet}
	{#snippet actions()}
		<button class="e-button e-button--primary" type="button" onclick={() => (buying = true)}>
			<PlusCircle size={16} /> Buy a gate
		</button>
	{/snippet}
</PageHeader>

{#if gates.length === 0}
	<div class="e-panel e-empty">
		<div class="e-empty__title">No gates</div>
		<p>Every route starts and ends at a gate. Buy one to get moving.</p>
	</div>
{:else}
	{#each gatesByAirport as [iata, airportGates] (iata)}
		{@const airport = getAirport(iata)}
		<section class="e-gates__airport">
			<header class="e-gates__header">
				<h3 class="e-gates__title">
					<MapPin size={14} /> {airport.iataCode} — {airport.name}
				</h3>
				<span class="e-gates__meta">
					{airport.city}, {airport.country} · tier {airport.tier} · {airport.landingFeePerTon} €/t
					+ {airport.passengerFee} €/pax
				</span>
			</header>

			<div class="e-cards-grid">
				{#each airportGates as gate (gate.key)}
					<div class="e-unit-card">
						<div class="e-unit-card__status e-status--in-use">
							<DoorOpen size={14} /> Gate {gate.number}
						</div>
						<div class="e-unit-card__id">≤ {gate.maxCategory}</div>
						<div class="e-unit-card__sub">Accepts aircraft category {gate.maxCategory} or lower</div>
						<div class="e-unit-card__location">
							<Plane size={12} />
							{aircraftByGate.get(gate.key) ?? 0} aircraft based here
						</div>
						<div class="e-unit-card__footer">
							<span class="e-tag">Paid <Money amount={gate.price} compact /></span>
							<span class="e-tag">{EMPLOYEES_PER_GATE} staff</span>
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/each}
{/if}

{#if buying}
	<Modal title="Buy a gate" onClose={() => (buying = false)}>
	<AirportPicker
			label="Airport"
			value={airportIata || null}
			onSelect={(code) => (airportIata = code ?? '')}
		/>

		{#if airportIata}
			{#if candidates.length === 0}
				<p class="e-gates__note">Every stand at this airport is taken.</p>
			{:else}
				<div class="e-field">
					<label class="e-field__label" for="gate-stand">
						Available stands ({candidates.length})
					</label>
					<select id="gate-stand" bind:value={selectedGateKey}>
						{#each candidates as gate (gate.key)}
							<option value={gate.key}>
								Gate {gate.number} · max category {gate.maxCategory} · {gate.price.toLocaleString('de-DE')} €
							</option>
						{/each}
					</select>
				</div>

				{#if selectedGate}
					{@const airport = getAirport(selectedGate.airportIata)}
					<div class="e-kv">
						<span class="e-kv__key">Price</span>
						<span class="e-kv__value"><Money amount={selectedGate.price} /></span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Largest aircraft category</span>
						<span class="e-kv__value">{selectedGate.maxCategory}</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Departure charges here</span>
						<span class="e-kv__value">
							{airport.landingFeePerTon} €/t + {airport.passengerFee} €/pax
						</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Staff added</span>
						<span class="e-kv__value">{EMPLOYEES_PER_GATE} external workers</span>
					</div>
					{#if company}
						<div class="e-kv">
							<span class="e-kv__key">Cash after purchase</span>
							<span class="e-kv__value">
								<Money amount={company.cash - selectedGate.price} />
							</span>
						</div>
					{/if}
				{/if}
			{/if}
		{/if}

		{#snippet footer()}
			<button class="e-button" type="button" onclick={() => (buying = false)}>Cancel</button>
			<button
				class="e-button e-button--primary"
				type="button"
				disabled={submitting ||
					selectedGateKey === null ||
					(company && selectedGate ? company.cash < selectedGate.price : true)}
				onclick={confirmPurchase}
			>
				{submitting ? 'Buying…' : 'Buy gate'}
			</button>
		{/snippet}
	</Modal>
{/if}

<style lang="scss">
	.e-gates__airport {
		margin-bottom: 28px;
	}

	.e-gates__header {
		margin-bottom: 12px;
	}

	.e-gates__title {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		font-weight: 600;
	}

	.e-gates__meta {
		color: #6b7280;
		font-size: 11px;
	}

	.e-gates__note {
		padding: 12px 0;
		color: #6b7280;
		font-size: 12px;
	}
</style>
