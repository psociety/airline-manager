<script lang="ts">
	import type { Snippet } from 'svelte';

	interface PageHeaderProps {
		title: string;
		subtitle?: string;
		actions?: Snippet;
		stats?: Snippet;
	}

	const { title, subtitle, actions, stats }: PageHeaderProps = $props();
</script>

<div class="e-dashboard-header">
	<div>
		<h1 class="e-dashboard-header__title">{title}</h1>
		{#if subtitle}
			<p class="e-dashboard-header__subtitle">{subtitle}</p>
		{/if}
	</div>

	{#if stats}
		<div class="e-stats-overview">{@render stats()}</div>
	{:else if actions}
		<div class="e-header-actions">{@render actions()}</div>
	{/if}
</div>

{#if stats && actions}
	<div class="e-header-actions e-header-actions--below">{@render actions()}</div>
{/if}

<style lang="scss">
	.e-header-actions {
		display: flex;
		align-items: center;
		gap: 8px;

		&--below {
			margin-bottom: 20px;
		}
	}
</style>
