<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$lib/paths';
	import { getAirport } from '$data/airports';
	import { maxCategoryForAirport } from '$data/gates';
	import { availableGateCountAt, createCompany, isIcaoTaken } from '$db/repo';
	import { STARTING_CASH, TOTAL_SHARES } from '$db/schema';
	import { formatMoney } from '$engine/economy';
	import { game } from '$state/game.svelte';
	import AirportPicker from '$components/AirportPicker.svelte';
	import { ArrowLeft, Building2, Check, MapPin } from 'lucide-svelte';

	let name = $state('');
	let icao = $state('');
	let airportIata = $state('');
	let icaoError = $state('');
	let submitting = $state(false);

	const selectedAirport = $derived(airportIata ? getAirport(airportIata) : null);

	let freeGates = $state(0);
	$effect(() => {
		if (!airportIata) {
			freeGates = 0;
			return;
		}
		void availableGateCountAt(airportIata).then((count) => {
			freeGates = count;
		});
	});

	const nameValid = $derived(name.trim().length >= 3);
	const icaoValid = $derived(/^[A-Za-z]{3}$/.test(icao.trim()));
	const canSubmit = $derived(
		nameValid && icaoValid && Boolean(airportIata) && !icaoError && !submitting
	);

	const checkIcao = async (): Promise<void> => {
		icaoError = '';
		if (!icaoValid) return;
		if (await isIcaoTaken(icao)) icaoError = 'That code is already used by another airline';
	};

	const found = async (): Promise<void> => {
		submitting = true;
		await checkIcao();
		if (icaoError) {
			submitting = false;
			return;
		}

		const company = await game.act(
			() =>
				createCompany({
					name: name.trim(),
					icao: icao.trim().toUpperCase(),
					homeIata: airportIata
				}),
			`${name.trim()} is airborne. Welcome aboard.`
		);

		submitting = false;
		if (company) await goto(`${base}/${company.slug}`);
	};
</script>

<div class="e-app-body">
	<main class="e-main-content">
		<div class="e-dashboard-header">
			<div>
				<h1 class="e-dashboard-header__title">FOUND AN AIRLINE</h1>
				<p class="e-dashboard-header__subtitle">
					Three details and you are in business.
				</p>
			</div>
			<a class="e-button e-button--ghost e-button--small" href="{base}/">
				<ArrowLeft size={14} /> Back
			</a>
		</div>

		<div class="e-onboarding">
			<div class="e-panel">
				<h3 class="e-panel__title"><Building2 size={14} /> Airline details</h3>

				<div class="e-field">
					<label class="e-field__label" for="airline-name">Airline name</label>
					<input
						id="airline-name"
						type="text"
						bind:value={name}
						maxlength="40"
						placeholder="Raca Airline"
					/>
					{#if name && !nameValid}
						<span class="e-field__error">At least 3 characters</span>
					{/if}
				</div>

				<div class="e-field">
					<label class="e-field__label" for="airline-icao">ICAO code (3 letters)</label>
					<input
						id="airline-icao"
						type="text"
						bind:value={icao}
						maxlength="3"
						placeholder="RCA"
						style:text-transform="uppercase"
						onblur={checkIcao}
					/>
					{#if icao && !icaoValid}
						<span class="e-field__error">Exactly three letters</span>
					{:else if icaoError}
						<span class="e-field__error">{icaoError}</span>
					{/if}
				</div>

				<AirportPicker
					label="Home airport"
					value={airportIata || null}
					hint="You get one free gate here, the best stand still available."
					onSelect={(code) => (airportIata = code ?? '')}
				/>
			</div>

			<div class="e-panel">
				<h3 class="e-panel__title"><MapPin size={14} /> Starting position</h3>

				<div class="e-kv">
					<span class="e-kv__key">Starting capital</span>
					<span class="e-kv__value">{formatMoney(STARTING_CASH)}</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Shares issued to you</span>
					<span class="e-kv__value">{TOTAL_SHARES.toLocaleString('de-DE')} (100%)</span>
				</div>

				{#if selectedAirport}
					<div class="e-kv">
						<span class="e-kv__key">Home base</span>
						<span class="e-kv__value">{selectedAirport.city}</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Airport tier</span>
						<span class="e-kv__value">{selectedAirport.tier} / 10</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Runway</span>
						<span class="e-kv__value">{selectedAirport.runwayLength} m</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Heaviest aircraft category</span>
						<span class="e-kv__value">{maxCategoryForAirport(selectedAirport)}</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Stands still for sale</span>
						<span class="e-kv__value">{freeGates}</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Departure charges</span>
						<span class="e-kv__value">
							{selectedAirport.landingFeePerTon} €/t + {selectedAirport.passengerFee} €/pax
						</span>
					</div>
				{:else}
					<p class="e-onboarding__hint">
						Pick a country and airport to see what you are getting into.
					</p>
				{/if}

				<button
					class="e-button e-button--primary e-button--block e-onboarding__submit"
					type="button"
					disabled={!canSubmit}
					onclick={found}
				>
					<Check size={16} /> {submitting ? 'Filing paperwork…' : 'Found the airline'}
				</button>
			</div>
		</div>
	</main>
</div>

<style lang="scss">
	.e-onboarding {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 20px;
	}

	.e-onboarding__hint {
		padding: 16px 0;
		color: #6b7280;
		font-size: 12px;
	}

	.e-onboarding__submit {
		margin-top: 20px;
	}

	:global(.e-panel__title) {
		display: flex;
		align-items: center;
		gap: 6px;
	}
</style>
