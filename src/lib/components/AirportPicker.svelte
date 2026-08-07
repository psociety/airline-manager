<script lang="ts">
	import { AIRPORTS, COUNTRIES } from '$data/airports';
	import type { Airport } from '$data/types';
	import { MapPin, Search, X } from 'lucide-svelte';

	interface AirportPickerProps {
		/** IATA code of the current selection, or null. */
		value: string | null;
		onSelect: (iataCode: string | null) => void;
		label?: string;
		hint?: string;
		/** Codes that cannot be chosen, e.g. the origin of the route being planned. */
		disabledCodes?: string[];
	}

	const {
		value,
		onSelect,
		label = 'Airport',
		hint,
		disabledCodes = []
	}: AirportPickerProps = $props();

	/** Enough to scroll through without rendering three hundred rows. */
	const MAX_RESULTS = 40;

	let query = $state('');
	let country = $state('');

	const blocked = $derived(new Set(disabledCodes));
	const selected = $derived(
		value ? (AIRPORTS.find((airport) => airport.iataCode === value) ?? null) : null
	);

	const normalise = (text: string): string =>
		text
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '');

	/**
	 * Free-text search across city, airport name, IATA code and country. With an empty
	 * query it falls back to browsing by country, which is how the pickers worked before
	 * the dataset grew to three hundred airports.
	 */
	const countryAirports = $derived(
		COUNTRIES.find((group) => group.country === country)?.airports ?? []
	);

	const matches = $derived.by(() => {
		const terms = normalise(query).split(/\s+/).filter(Boolean);

		const pool = terms.length > 0 ? AIRPORTS : country ? countryAirports : [];
		const found = pool.filter((airport) => {
			if (terms.length === 0) return true;
			const haystack = normalise(
				`${airport.city} ${airport.name} ${airport.iataCode} ${airport.country}`
			);
			return terms.every((term) => haystack.includes(term));
		});

		return found
			.sort((left, right) => right.tier - left.tier || left.city.localeCompare(right.city))
			.slice(0, MAX_RESULTS);
	});

	const totalMatching = $derived.by(() => {
		const terms = normalise(query).split(/\s+/).filter(Boolean);
		if (terms.length === 0) return countryAirports.length;

		return AIRPORTS.filter((airport) => {
			const haystack = normalise(
				`${airport.city} ${airport.name} ${airport.iataCode} ${airport.country}`
			);
			return terms.every((term) => haystack.includes(term));
		}).length;
	});

	const choose = (airport: Airport): void => {
		if (blocked.has(airport.iataCode)) return;
		onSelect(airport.iataCode);
	};

	const clear = (): void => {
		query = '';
		country = '';
		onSelect(null);
	};
</script>

<div class="e-airport-picker">
	<span class="e-field__label">{label}</span>

	{#if selected}
		<div class="e-airport-picker__selected">
			<span class="e-airport-picker__code">{selected.iataCode}</span>
			<span class="e-airport-picker__selected-text">
				{selected.city}, {selected.country}
				<span class="e-airport-picker__meta">{selected.name}</span>
			</span>
			<button class="e-airport-picker__clear" type="button" onclick={clear} aria-label="Clear">
				<X size={14} />
			</button>
		</div>
	{:else}
		<div class="e-airport-picker__search">
			<Search size={14} />
			<input
				type="text"
				placeholder="Search a city, airport or code…"
				bind:value={query}
				aria-label="Search airports"
			/>
		</div>

		{#if query.trim().length === 0}
			<select bind:value={country} aria-label="Browse by country">
				<option value="">Or browse by country…</option>
				{#each COUNTRIES as group (group.country)}
					<option value={group.country}>{group.country} ({group.airports.length})</option>
				{/each}
			</select>
		{/if}

		{#if matches.length > 0}
			<ul class="e-airport-picker__results">
				{#each matches as airport (airport.iataCode)}
					{@const unavailable = blocked.has(airport.iataCode)}
					<li>
						<button
							class="e-airport-picker__option"
							class:e-airport-picker__option--disabled={unavailable}
							type="button"
							disabled={unavailable}
							onclick={() => choose(airport)}
						>
							<span class="e-airport-picker__code">{airport.iataCode}</span>
							<span class="e-airport-picker__option-text">
								{airport.city}, {airport.country}
								<span class="e-airport-picker__meta">
									{airport.name} · tier {airport.tier} · {airport.runwayLength} m
								</span>
							</span>
							{#if unavailable}<span class="e-tag">in use</span>{/if}
						</button>
					</li>
				{/each}
			</ul>

			{#if totalMatching > matches.length}
				<p class="e-airport-picker__note">
					Showing {matches.length} of {totalMatching} — keep typing to narrow it down.
				</p>
			{/if}
		{:else if query.trim().length > 0}
			<p class="e-airport-picker__note">
				<MapPin size={12} /> No airport matches “{query}”.
			</p>
		{/if}
	{/if}

	{#if hint}
		<span class="e-field__hint">{hint}</span>
	{/if}
</div>

<style lang="scss">
	.e-airport-picker {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 16px;

		&__search {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 0 10px;
			background: #ffffff;
			border: 1px solid #e5e7eb;
			border-radius: 6px;

			input {
				width: 100%;
				padding: 9px 0;
				font-size: 13px;
				border: none;
				outline: none;
			}
		}

		select {
			width: 100%;
			padding: 9px 10px;
			font-size: 13px;
			background: #ffffff;
			border: 1px solid #e5e7eb;
			border-radius: 6px;
		}

		&__results {
			max-height: 240px;
			margin: 0;
			padding: 0;
			overflow-y: auto;
			list-style: none;
			background: #ffffff;
			border: 1px solid #e5e7eb;
			border-radius: 6px;
		}

		&__option,
		&__selected {
			display: flex;
			align-items: center;
			gap: 10px;
			width: 100%;
			padding: 8px 10px;
			text-align: left;
			background: none;
			border: none;
			border-bottom: 1px solid #f1f2f5;
		}

		&__option {
			cursor: pointer;

			&:hover:not(:disabled) {
				background: #f8f9fb;
			}

			&--disabled {
				opacity: 0.5;
				cursor: not-allowed;
			}
		}

		&__selected {
			background: rgba(0, 208, 156, 0.12);
			border: 1px solid rgba(0, 208, 156, 0.5);
			border-radius: 6px;
		}

		&__code {
			flex-shrink: 0;
			width: 44px;
			color: var(--accent-blue);
			font-size: 12px;
			font-weight: 900;
			letter-spacing: 0.5px;
		}

		&__option-text,
		&__selected-text {
			flex: 1;
			font-size: 12px;
			font-weight: 600;
		}

		&__meta {
			display: block;
			overflow: hidden;
			color: #6b7280;
			font-size: 10px;
			font-weight: 400;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		&__clear {
			padding: 4px;
			color: #6b7280;
			background: none;
			border: none;
			cursor: pointer;
		}

		&__note {
			display: flex;
			align-items: center;
			gap: 4px;
			color: #6b7280;
			font-size: 11px;
		}
	}
</style>
