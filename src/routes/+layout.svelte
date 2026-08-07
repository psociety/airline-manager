<script lang="ts">
	import '$lib/styles/global.scss';
	import { game } from '$state/game.svelte';
	import Toasts from '$components/Toasts.svelte';
	import AwaySummary from '$components/AwaySummary.svelte';
	import type { Snippet } from 'svelte';

	const { children }: { children: Snippet } = $props();

	game.boot();
</script>

<div class="e-app-window">
	<div>
		<div class="e-brand-title">Airline <span class="e-brand-title__light">Manager Simulator</span></div>
	</div>

	{#if game.bootError}
		<div class="e-boot">
			<div class="e-empty__title">The world could not be loaded</div>
			<p>{game.bootError}</p>
		</div>
	{:else if !game.booted}
		<div class="e-boot">
			<div class="e-empty__title">Preparing the world…</div>
			<p>Building airports, stands and rival airlines.</p>
		</div>
	{:else}
		{@render children()}
	{/if}
</div>

<Toasts />

{#if game.awaySummary}
	<AwaySummary summary={game.awaySummary} />
{/if}

<style lang="scss">
	.e-boot {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		color: rgba(255, 255, 255, 0.75);
		font-size: 14px;
	}
</style>
