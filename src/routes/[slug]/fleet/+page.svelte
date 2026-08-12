<script lang="ts">
	import { base } from '$lib/paths';
	import { page } from '$app/stores';
	import Countdown from '$components/Countdown.svelte';
	import Modal from '$components/Modal.svelte';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import ProgressBar from '$components/ProgressBar.svelte';
	import PayloadSummary from '$components/PayloadSummary.svelte';
	import SeatConfigurator from '$components/SeatConfigurator.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { onAircraftImageError } from '$data/images';
	import { getModel, totalSeats } from '$data/aircraft';
	import type { SeatConfig } from '$data/types';
	import {
		companyFleet,
		companyGates,
		disposeAircraft,
		reconfigureSeats,
		renameAircraft,
		sendToMaintenance
	} from '$db/repo';
	import { db, type Aircraft, type Company } from '$db/schema';
	import { accidentProbability, maintenanceProgress, overrunKm } from '$engine/maintenance';
	import { aircraftResaleValue, formatCompactMoney, maintenanceCost } from '$engine/economy';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import {
		AlertCircle,
		AlertTriangle,
		Armchair,
		Gauge,
		Package,
		Pencil,
		Plane,
		Power,
		ShoppingCart,
		Trash2,
		Users,
		Wrench
	} from 'lucide-svelte';

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let fleet = $state<Aircraft[]>([]);
	let editing = $state<Aircraft | null>(null);
	let editName = $state('');
	let editSeats = $state<SeatConfig>({ economy: 0, business: 0, first: 0 });
	let gateLabels = $state(new Map<string, string>());

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;
			fleet = await companyFleet(found.id);

			const gates = await companyGates(found.id);
			gateLabels = new Map(
				gates.map((gate) => [gate.key, `${gate.airportIata} · ${gate.number}`])
			);
		})();
	});

	const employees = $derived(
		fleet.reduce((sum, aircraft) => sum + getModel(aircraft.modelId).employees, 0)
	);
	const seatCount = $derived(fleet.reduce((sum, aircraft) => sum + totalSeats(aircraft.seats), 0));

	const statusMeta = (aircraft: Aircraft) => {
		switch (aircraft.status) {
			case 'delivering':
				return { className: 'e-status--pending', icon: Package, label: 'In delivery' };
			case 'flying':
				return { className: 'e-status--in-use', icon: Power, label: 'In flight' };
			case 'maintenance':
				return { className: 'e-status--service', icon: Wrench, label: 'In maintenance' };
			case 'grounded':
				return { className: 'e-status--error', icon: AlertCircle, label: 'Grounded' };
			default:
				return { className: 'e-status--idle', icon: Power, label: 'Idle' };
		}
	};

	const openEditor = (aircraft: Aircraft): void => {
		editing = aircraft;
		editName = aircraft.name;
		editSeats = { ...aircraft.seats };
	};

	const disposeOfAircraft = async (aircraft: Aircraft): Promise<void> => {
		const question =
			aircraft.ownership === 'owned'
				? `Sell ${aircraft.name} for ${formatCompactMoney(aircraftResaleValue(aircraft))}? Its schedule will be dropped.`
				: `Hand ${aircraft.name} back to the lessor? Its schedule will be dropped.`;
		if (!confirm(question)) return;

		await game.act(
			() => disposeAircraft(aircraft.id),
			aircraft.ownership === 'owned' ? `${aircraft.name} sold` : `${aircraft.name} returned`
		);
	};

	const serviceAircraft = async (aircraft: Aircraft): Promise<void> => {
		const hours = getModel(aircraft.modelId).maintenanceHours;
		if (!confirm(`Take ${aircraft.name} out of service for ${hours} hours?`)) return;

		await game.act(
			() => sendToMaintenance(aircraft.id),
			`${aircraft.name} is in the hangar for ${hours} hours`
		);
	};

	const saveEditor = async (): Promise<void> => {
		if (!editing) return;
		const aircraftId = editing.id;

		await game.act(async () => {
			await renameAircraft(aircraftId, editName);
			await reconfigureSeats(aircraftId, editSeats);
		}, 'Aircraft updated');

		editing = null;
	};
</script>

<PageHeader title="FLEET" subtitle="{fleet.length} aircraft on the books">
	{#snippet stats()}
		<StatBox icon={Armchair} value={seatCount.toLocaleString('de-DE')} label="Seats installed" />
		<StatBox icon={Users} value={employees.toLocaleString('de-DE')} label="Crew required" />
	{/snippet}
	{#snippet actions()}
		<a class="e-button e-button--primary" href={`${base}/${slug}/fleet/market`}>
			<ShoppingCart size={16} /> Buy or lease
		</a>
	{/snippet}
</PageHeader>

{#if fleet.length === 0}
	<div class="e-panel e-empty">
		<div class="e-empty__title">No aircraft yet</div>
		<p>Your first aircraft is delivered instantly. Every later order takes up to an hour.</p>
		<p class="e-fleet__cta">
			<a class="e-button e-button--primary" href={`${base}/${slug}/fleet/market`}>
				<ShoppingCart size={16} /> Open the aircraft market
			</a>
		</p>
	</div>
{:else}
	<div class="e-cards-grid e-cards-grid--wide">
		{#each fleet as aircraft (aircraft.id)}
			{@const model = getModel(aircraft.modelId)}
			{@const meta = statusMeta(aircraft)}
			{@const wear = maintenanceProgress(aircraft)}
			<div class="e-unit-card">
				<div class="e-unit-card__status {meta.className}">
					<meta.icon size={14} />
					{meta.label}
					{#if aircraft.status === 'delivering'}
						· <Countdown until={aircraft.deliveryAt} doneLabel="arriving" />
					{:else if aircraft.status === 'maintenance' && aircraft.maintenanceUntil}
						· <Countdown until={aircraft.maintenanceUntil} doneLabel="finishing" />
					{/if}
				</div>

				<img
					class="e-unit-card__image"
					src={model.imageUrl}
					alt={model.name}
					loading="lazy"
					onerror={onAircraftImageError}
				/>

				<div class="e-unit-card__id">{aircraft.name}</div>
				<div class="e-unit-card__sub">
					{model.manufacturer} {model.name} · {aircraft.registration}
				</div>

				<div class="e-unit-card__location">
					<Plane size={12} />
					{aircraft.currentIata} · {gateLabels.get(aircraft.homeGateId) ?? 'no home gate'} ·
					category {model.category}
				</div>

				<div class="e-fleet__seats">
					{#if model.kind === 'cargo'}
						<span class="e-tag e-tag--yellow">Freight</span>
						<span>{model.payload.toLocaleString('de-DE')} t hold</span>
					{:else}
						<span>{aircraft.seats.economy} eco</span>
						<span>{aircraft.seats.business} bus</span>
						<span>{aircraft.seats.first} first</span>
					{/if}
					<span class="e-tag">{model.employees} crew</span>
				</div>

				<ProgressBar
					label="MAINTENANCE {Math.round(Math.min(1, wear) * 100)}% · {Math.round(
						aircraft.kmSinceMaintenance
					).toLocaleString('de-DE')} / {model.maintenanceIntervalKm.toLocaleString('de-DE')} KM"
					value={wear}
					icon={Gauge}
				/>

				{#if overrunKm(aircraft) > 0 && aircraft.status !== 'maintenance'}
					<div class="e-fleet__warning">
						<AlertTriangle size={12} />
						Overdue by {Math.round(overrunKm(aircraft)).toLocaleString('de-DE')} km —
						{(accidentProbability(aircraft) * 100).toFixed(1)}% accident risk per flight
					</div>
				{/if}

				{#if aircraft.status === 'idle' || aircraft.status === 'grounded'}
					<div class="e-fleet__actions">
						<button
							class="e-button e-button--small"
							type="button"
							onclick={() => serviceAircraft(aircraft)}
						>
							<Wrench size={12} /> Check
							(<Money amount={maintenanceCost(aircraft.modelId)} compact />, {model.maintenanceHours} h)
						</button>
						<button
							class="e-button e-button--small"
							type="button"
							onclick={() => disposeOfAircraft(aircraft)}
						>
							<Trash2 size={12} />
							{aircraft.ownership === 'owned' ? 'Sell' : 'Return lease'}
							{#if aircraft.ownership === 'owned'}
								(<Money amount={aircraftResaleValue(aircraft)} compact />)
							{/if}
						</button>
					</div>
				{/if}

				<div class="e-unit-card__footer">
					<span class="e-tag">
						{aircraft.ownership === 'leased' ? 'Leased' : 'Owned'}
						{#if aircraft.ownership === 'leased'}
							· <Money amount={aircraft.leaseDailyRate} compact />/day
						{/if}
					</span>
					<button
						class="e-button e-button--small"
						type="button"
						onclick={() => openEditor(aircraft)}
					>
						<Pencil size={12} /> Configure
					</button>
				</div>

				<div class="e-fleet__meta">
					<span>Range {model.range.toLocaleString('de-DE')} km</span>
					<span>Speed {model.speed} km/h</span>
					<span>Total {Math.round(aircraft.totalKm).toLocaleString('de-DE')} km</span>
					<span>Check {model.maintenanceHours} h</span>
				</div>
			</div>
		{/each}
	</div>
{/if}

{#if editing}
	{@const model = getModel(editing.modelId)}
	<Modal title="Configure {editing.name}" onClose={() => (editing = null)}>
		<div class="e-field">
			<label class="e-field__label" for="aircraft-name">Aircraft name</label>
			<input id="aircraft-name" type="text" bind:value={editName} maxlength="40" />
		</div>

	{#if model.kind === 'cargo'}
			<PayloadSummary {model} />
		{:else}
			<SeatConfigurator {model} seats={editSeats} onChange={(seats) => (editSeats = seats)} />
		{/if}

		{#if editing.status === 'flying'}
			<p class="e-fleet__warning">
				<AlertTriangle size={12} /> This aircraft is airborne — the cabin cannot be refitted until
				it lands.
			</p>
		{/if}

		{#snippet footer()}
			<button class="e-button" type="button" onclick={() => (editing = null)}>Cancel</button>
			<button class="e-button e-button--primary" type="button" onclick={saveEditor}>
				Save changes
			</button>
		{/snippet}
	</Modal>
{/if}

<style lang="scss">
	.e-fleet__seats {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		color: #6b7280;
		font-size: 11px;
		font-weight: 600;
	}

	.e-fleet__meta {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		color: #6b7280;
		font-size: 10px;
	}

	.e-fleet__warning {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px;
		color: #7f1d1d;
		font-size: 11px;
		font-weight: 600;
		background: rgba(255, 59, 48, 0.1);
		border-radius: 6px;
	}

	.e-fleet__cta {
		margin-top: 16px;
	}

	.e-fleet__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
</style>
