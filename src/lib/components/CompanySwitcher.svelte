<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$lib/paths';
	import { page } from '$app/stores';
	import { playerCompanies } from '$db/repo';
	import type { Company } from '$db/schema';
	import { game } from '$state/game.svelte';
	import { ChevronDown, PlusCircle } from 'lucide-svelte';

	const { company }: { company: Company } = $props();

	let open = $state(false);
	let companies = $state<Company[]>([]);

	$effect(() => {
		void game.revision;
		void playerCompanies().then((list) => {
			companies = list;
		});
	});

	/** Keeps the player on the same section when switching airlines. */
	const switchTo = async (target: Company): Promise<void> => {
		open = false;
		if (target.slug === company.slug) return;

		// Dropped from the front so the segments count from the airline's slug whether the game is
		// served at the root or under a base path.
		const section = $page.url.pathname.slice(base.length).split('/').slice(2).join('/');
		await goto(`${base}/${target.slug}${section ? `/${section}` : ''}`);
	};
</script>

<div class="e-switcher">
	<button class="e-company-badge" type="button" onclick={() => (open = !open)}>
		<span class="e-company-badge__name">{company.name}</span>
		<span class="e-company-badge__code" style:background-color={company.colour === '#ffcc00' ? '#0d1e40' : undefined}>
			{company.icao}
		</span>
		<ChevronDown size={14} />
	</button>

	{#if open}
		<div class="e-company-switcher">
			{#each companies as candidate (candidate.id)}
				<button
					class="e-company-switcher__item"
					class:e-company-switcher__item--active={candidate.id === company.id}
					type="button"
					onclick={() => switchTo(candidate)}
				>
					<span>{candidate.name}</span>
					<span class="e-company-switcher__code">{candidate.icao}</span>
				</button>
			{/each}
			<button
				class="e-company-switcher__item"
				type="button"
				onclick={() => {
					open = false;
					void goto(`${base}/new`);
				}}
			>
				<span><PlusCircle size={12} /> Found another airline</span>
			</button>
		</div>
	{/if}
</div>

<style lang="scss">
	.e-switcher {
		position: relative;
	}

	.e-company-switcher {
		position: absolute;
		z-index: 20;
		right: 0;
		left: 0;
		box-shadow: 0 10px 25px rgba(0, 0, 0, 0.12);
	}
</style>
