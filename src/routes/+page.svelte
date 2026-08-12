<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$lib/paths';
	import { getAirport } from '$data/airports';
	import { companyValuation, playerCompanies } from '$db/repo';
	import { STARTING_CASH, TOTAL_SHARES, db, type Company } from '$db/schema';
	import { resetWorld } from '$db/seed';
	import { exportSave, importSave, saveFileName } from '$db/backup';
	import { formatCompactMoney, formatMoney } from '$engine/economy';
	import { game } from '$state/game.svelte';
	import { Download, Plane, PlusCircle, RotateCcw, Upload } from 'lucide-svelte';

	interface CompanyRow {
		company: Company;
		fleetSize: number;
		routeCount: number;
		sharePrice: number;
	}

	let rows = $state<CompanyRow[]>([]);
	let loading = $state(true);

	const load = async (): Promise<void> => {
		const companies = await playerCompanies();
		rows = await Promise.all(
			companies.map(async (company) => ({
				company,
				fleetSize: await db.aircraft.where('companyId').equals(company.id).count(),
				routeCount: await db.routes.where('companyId').equals(company.id).count(),
				sharePrice: (await companyValuation(company.id)).sharePrice
			}))
		);
		loading = false;
	};

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		void load();
	});

	const restart = async (): Promise<void> => {
		if (!confirm('Delete every airline and rebuild the world from scratch?')) return;
		await resetWorld();
		location.reload();
	};

	let fileInput = $state<HTMLInputElement | null>(null);
	let working = $state(false);

	/** Writes the whole world to a JSON file, for sharing or keeping as a backup. */
	const exportWorld = async (): Promise<void> => {
		working = true;
		const contents = await exportSave();

		const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = saveFileName();
		link.click();
		URL.revokeObjectURL(url);

		working = false;
		game.toast('Save exported');
	};

	const importWorld = async (file: File): Promise<void> => {
		if (!confirm('Replace your current world with the contents of this file?')) return;

		working = true;
		const contents = await file.text();
		const restored = await game.act(() => importSave(contents), 'Save loaded');
		working = false;

		if (restored !== null) location.reload();
	};
</script>

<div class="e-app-body">
	<main class="e-main-content">
		<div class="e-dashboard-header">
			<div>
				<h1 class="e-dashboard-header__title">YOUR AIRLINES</h1>
				<p class="e-dashboard-header__subtitle">
					Pick an airline to manage, or found a new one.
				</p>
			</div>
			<div class="e-landing__actions">
				<button
					class="e-button e-button--ghost e-button--small"
					type="button"
					disabled={working}
					onclick={exportWorld}
				>
					<Download size={14} /> Export save
				</button>
				<button
					class="e-button e-button--ghost e-button--small"
					type="button"
					disabled={working}
					onclick={() => fileInput?.click()}
				>
					<Upload size={14} /> Import save
				</button>
				<input
					class="e-landing__file"
					type="file"
					accept="application/json,.json"
					bind:this={fileInput}
					onchange={(event) => {
						const file = event.currentTarget.files?.[0];
						event.currentTarget.value = '';
						if (file) void importWorld(file);
					}}
				/>
				<button class="e-button e-button--ghost e-button--small" type="button" onclick={restart}>
					<RotateCcw size={14} /> Restart world
				</button>
				<a class="e-button e-button--primary" href="{base}/new">
					<PlusCircle size={16} /> Found an airline
				</a>
			</div>
		</div>

		{#if loading}
			<div class="e-empty">Loading…</div>
		{:else if rows.length === 0}
			<div class="e-panel e-empty">
				<div class="e-empty__title">No airline yet</div>
				<!-- Both figures read off the constants they describe, rather than written out: the
				     opening balance is a tuning value, and a hardcoded one here drifted to ten times
				     the real figure the last time it moved. -->
				<p>
					You start with {formatMoney(STARTING_CASH)}, all
					{TOTAL_SHARES.toLocaleString('de-DE')} shares of your company and one free gate at your
					home airport.
				</p>
				<p class="e-landing__cta">
					<a class="e-button e-button--primary" href="{base}/new">
						<PlusCircle size={16} /> Found your first airline
					</a>
				</p>
			</div>
		{:else}
			<div class="e-cards-grid">
				{#each rows as row (row.company.id)}
					<button
						class="e-unit-card e-unit-card--clickable"
						type="button"
						onclick={() => goto(`${base}/${row.company.slug}`)}
					>
						<div class="e-unit-card__status e-status--in-use">
							<Plane size={14} /> {getAirport(row.company.homeIata).city}
						</div>
						<div class="e-unit-card__id">{row.company.icao}</div>
						<div class="e-unit-card__sub">{row.company.name}</div>
						<div class="e-unit-card__location">
							{formatCompactMoney(row.company.cash)} cash · {row.sharePrice.toLocaleString('de-DE')} €/share
						</div>
						<div class="e-unit-card__footer">
							<span class="e-tag">{row.fleetSize} aircraft</span>
							<span class="e-tag">{row.routeCount} routes</span>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</main>
</div>

<style lang="scss">
	.e-landing__actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.e-landing__cta {
		margin-top: 16px;
	}

	.e-landing__file {
		display: none;
	}
</style>
