<script lang="ts">
	import { page } from '$app/stores';
	import Modal from '$components/Modal.svelte';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import PayloadSummary from '$components/PayloadSummary.svelte';
	import SeatConfigurator from '$components/SeatConfigurator.svelte';
	import { AIRCRAFT_MODELS, MANUFACTURERS, defaultSeatConfig } from '$data/aircraft';
	import { onAircraftImageError } from '$data/images';
	import type { AircraftModelDerived, SeatConfig } from '$data/types';
	import { acquireAircraft, companyGates } from '$db/repo';
	import type { Company, OwnedGate } from '$db/schema';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import { ArrowLeft, Banknote, Filter, KeyRound, Search } from 'lucide-svelte';

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let gates = $state<OwnedGate[]>([]);

	let search = $state('');
	let manufacturer = $state('');
	let affordableOnly = $state(false);
	let kind = $state<'all' | 'passenger' | 'cargo'>('all');
	let sortBy = $state<'price' | 'seats' | 'range' | 'speed'>('price');

	let ordering = $state<AircraftModelDerived | null>(null);
	let orderName = $state('');
	let orderSeats = $state<SeatConfig>({ economy: 0, business: 0, first: 0 });
	let orderOwnership = $state<'owned' | 'leased'>('owned');
	let orderGateKey = $state<string | null>(null);
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
		})();
	});

	const visibleModels = $derived(
		AIRCRAFT_MODELS.filter((model) => {
			if (kind !== 'all' && model.kind !== kind) return false;
			if (manufacturer && model.manufacturer !== manufacturer) return false;
			if (search && !`${model.manufacturer} ${model.name}`.toLowerCase().includes(search.toLowerCase()))
				return false;
			if (affordableOnly && company && model.price > company.cash) return false;
			return true;
		}).sort((left, right) => {
			switch (sortBy) {
				case 'seats':
					return right.capacityUnits - left.capacityUnits;
				case 'range':
					return right.range - left.range;
				case 'speed':
					return right.speed - left.speed;
				default:
					return left.price - right.price;
			}
		})
	);

	/** Stands that can physically take this model, so the order cannot be invalid. */
	const eligibleGates = $derived.by(() => {
		const model = ordering;
		if (!model) return [];
		return gates.filter((gate) => gate.maxCategory >= model.category);
	});

	const openOrder = (model: AircraftModelDerived): void => {
		ordering = model;
		orderName = `${company?.icao ?? ''} ${model.name}`.trim();
		orderSeats = defaultSeatConfig(model);
		orderOwnership = 'owned';
		const eligible = gates.filter((gate) => gate.maxCategory >= model.category);
		orderGateKey = eligible[0]?.key ?? null;
	};

	const upfrontCost = $derived.by(() => {
		const model = ordering;
		if (!model) return 0;
		return orderOwnership === 'owned' ? model.price : model.leaseDeposit;
	});
	const canAffordOrder = $derived((company?.cash ?? 0) >= upfrontCost);

	const confirmOrder = async (): Promise<void> => {
		if (!ordering || !company || orderGateKey === null) return;
		submitting = true;

		const model = ordering;
		const result = await game.act(
			() =>
				acquireAircraft({
					companyId: company!.id,
					modelId: model.id,
					name: orderName,
					seats: orderSeats,
					ownership: orderOwnership,
					homeGateId: orderGateKey!
				}),
			company.firstAircraftDelivered === 0
				? `${orderName} delivered — it is ready to fly now`
				: `${orderName} ordered — watch the delivery countdown`
		);

		submitting = false;
		if (result) ordering = null;
	};
</script>

<PageHeader title="AIRCRAFT MARKET" subtitle="{visibleModels.length} of {AIRCRAFT_MODELS.length} types shown">
	{#snippet actions()}
		<a class="e-button e-button--ghost e-button--small" href={`/${slug}/fleet`}>
			<ArrowLeft size={14} /> Back to fleet
		</a>
	{/snippet}
</PageHeader>

<div class="e-market-filters">
	<div class="e-market-filters__search">
		<Search size={14} />
		<input type="text" placeholder="Search a type…" bind:value={search} />
	</div>

	<select bind:value={kind}>
		<option value="all">Passenger and freight</option>
		<option value="passenger">Passenger only</option>
		<option value="cargo">Freighters only</option>
	</select>

	<select bind:value={manufacturer}>
		<option value="">All manufacturers</option>
		{#each MANUFACTURERS as maker (maker)}
			<option value={maker}>{maker}</option>
		{/each}
	</select>

	<select bind:value={sortBy}>
		<option value="price">Cheapest first</option>
		<option value="seats">Most capacity</option>
		<option value="range">Longest range</option>
		<option value="speed">Fastest</option>
	</select>

	<label class="e-market-filters__toggle">
		<input type="checkbox" bind:checked={affordableOnly} />
		<Filter size={12} /> Affordable only
	</label>
</div>

{#if gates.length === 0}
	<div class="e-panel e-empty">
		<div class="e-empty__title">You need a gate first</div>
		<p>Aircraft are based at a gate you own. Buy one before ordering.</p>
	</div>
{/if}

<div class="e-cards-grid e-cards-grid--wide">
	{#each visibleModels as model (model.id)}
		{@const affordable = company ? model.price <= company.cash : false}
		{@const canBase = gates.some((gate) => gate.maxCategory >= model.category)}
		<div class="e-unit-card">
			<img
				class="e-unit-card__image"
				src={model.imageUrl}
				alt={model.name}
				loading="lazy"
				onerror={onAircraftImageError}
			/>
			<div class="e-unit-card__id">{model.name}</div>
			<div class="e-unit-card__sub">
				{model.manufacturer} · {model.introduction_year}
				{#if model.kind === 'cargo'}<span class="e-tag e-tag--yellow">Freight</span>{/if}
			</div>

			<div class="e-unit-card__location">
				Category {model.category} ·
				{model.kind === 'cargo'
					? `${model.payload.toLocaleString('de-DE')} t hold`
					: `${model.seats} slots`}
				· {model.range.toLocaleString('de-DE')} km
			</div>

			<div class="e-market__specs">
				<span>{model.speed} km/h</span>
				<span>{model.consumption} L/100km/seat</span>
				<span>{model.employees} crew</span>
				<span>Check every {model.maintenanceIntervalKm.toLocaleString('de-DE')} km</span>
			</div>

			<div class="e-market__prices">
				<div>
					<span class="e-market__price-label">Purchase</span>
					<Money amount={model.price} compact />
				</div>
				<div>
					<span class="e-market__price-label">Lease</span>
					<Money amount={model.leaseDailyRate} compact />/day
				</div>
			</div>

			<div class="e-unit-card__footer">
				{#if !canBase}
					<span class="e-tag e-tag--red">No suitable gate</span>
				{:else if !affordable}
					<span class="e-tag e-tag--yellow">Lease only</span>
				{:else}
					<span class="e-tag e-tag--teal">Available</span>
				{/if}
				<button
					class="e-button e-button--primary e-button--small"
					type="button"
					disabled={!canBase}
					onclick={() => openOrder(model)}
				>
					Order
				</button>
			</div>
		</div>
	{/each}
</div>

{#if ordering && company}
	<Modal title="Order {ordering.name}" wide onClose={() => (ordering = null)}>
		<div class="e-order">
			<div>
				<img
					class="e-order__image"
					src={ordering.imageUrl}
					alt={ordering.name}
					onerror={onAircraftImageError}
				/>

				<div class="e-kv">
					<span class="e-kv__key">Purchase price</span>
					<span class="e-kv__value"><Money amount={ordering.price} /></span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Lease</span>
					<span class="e-kv__value">
						<Money amount={ordering.leaseDailyRate} />/day
					</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Lease deposit</span>
					<span class="e-kv__value"><Money amount={ordering.leaseDeposit} /></span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">{ordering.kind === 'cargo' ? 'Hold' : 'Cabin'}</span>
					<span class="e-kv__value">
						{ordering.kind === 'cargo'
							? `${ordering.payload.toLocaleString('de-DE')} t`
							: `${ordering.seats} slots`}
					</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Crew added to externals</span>
					<span class="e-kv__value">{ordering.employees}</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Heavy check</span>
					<span class="e-kv__value">
						every {ordering.maintenanceIntervalKm.toLocaleString('de-DE')} km · {ordering.maintenanceHours} h
					</span>
				</div>
			</div>

			<div>
				<div class="e-field">
					<label class="e-field__label" for="order-name">Aircraft name</label>
					<input id="order-name" type="text" bind:value={orderName} maxlength="40" />
				</div>

				<div class="e-field">
					<span class="e-field__label">Acquisition</span>
					<div class="e-order__toggle">
						<button
							class="e-button"
							class:e-button--primary={orderOwnership === 'owned'}
							type="button"
							onclick={() => (orderOwnership = 'owned')}
						>
							<Banknote size={14} /> Buy
						</button>
						<button
							class="e-button"
							class:e-button--primary={orderOwnership === 'leased'}
							type="button"
							onclick={() => (orderOwnership = 'leased')}
						>
							<KeyRound size={14} /> Lease
						</button>
					</div>
				</div>

				<div class="e-field">
					<label class="e-field__label" for="order-gate">Home gate</label>
					<select id="order-gate" bind:value={orderGateKey}>
						{#each eligibleGates as gate (gate.key)}
							<option value={gate.key}>
								{gate.airportIata} · {gate.number} (max category {gate.maxCategory})
							</option>
						{/each}
					</select>
					<span class="e-field__hint">
						Only stands rated for category {ordering.category} or higher are listed.
					</span>
				</div>

				{#if ordering.kind === 'cargo'}
					<PayloadSummary model={ordering} />
				{:else}
					<SeatConfigurator
						model={ordering}
						seats={orderSeats}
						onChange={(seats) => (orderSeats = seats)}
					/>
				{/if}

				<div class="e-order__total">
					<span>Due now</span>
					<strong><Money amount={upfrontCost} /></strong>
				</div>
				<div class="e-order__total e-order__total--muted">
					<span>Cash after order</span>
					<strong><Money amount={company.cash - upfrontCost} /></strong>
				</div>
				{#if company.firstAircraftDelivered === 0}
					<p class="e-order__note">
						First aircraft of the airline — delivered immediately.
					</p>
				{:else}
					<p class="e-order__note">Delivery takes up to one hour.</p>
				{/if}
			</div>
		</div>

		{#snippet footer()}
			<button class="e-button" type="button" onclick={() => (ordering = null)}>Cancel</button>
			<button
				class="e-button e-button--primary"
				type="button"
				disabled={submitting || orderGateKey === null || !canAffordOrder}
				onclick={confirmOrder}
			>
				{!canAffordOrder ? 'Not enough cash' : submitting ? 'Ordering…' : 'Confirm order'}
			</button>
		{/snippet}
	</Modal>
{/if}

<style lang="scss">
	.e-market-filters {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 20px;

		&__search {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 0 10px;
			background: #ffffff;
			border: 1px solid #e5e7eb;
			border-radius: 6px;

			input {
				padding: 8px 0;
				font-size: 13px;
				border: none;
				outline: none;
			}
		}

		&__toggle {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 0 10px;
			font-size: 12px;
			font-weight: 600;
			background: #ffffff;
			border: 1px solid #e5e7eb;
			border-radius: 6px;
		}

		select {
			padding: 8px 10px;
			font-size: 13px;
			background: #ffffff;
			border: 1px solid #e5e7eb;
			border-radius: 6px;
		}
	}

	.e-market__specs {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		color: #6b7280;
		font-size: 10px;
	}

	.e-market__prices {
		display: flex;
		justify-content: space-between;
		padding-top: 8px;
		border-top: 1px solid #f1f2f5;
		font-size: 13px;
	}

	.e-market__price-label {
		display: block;
		color: #6b7280;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}

	.e-order {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 24px;

		&__image {
			width: 100%;
			height: 140px;
			margin-bottom: 12px;
			object-fit: contain;
		}

		&__toggle {
			display: flex;
			gap: 8px;
		}

		&__total {
			display: flex;
			justify-content: space-between;
			margin-top: 12px;
			font-size: 14px;

			&--muted {
				color: #6b7280;
				font-size: 12px;
			}
		}

		&__note {
			margin-top: 8px;
			color: #6b7280;
			font-size: 11px;
		}
	}
</style>
