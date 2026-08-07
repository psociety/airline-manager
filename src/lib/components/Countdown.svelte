<script lang="ts">
	import { formatDuration } from '$engine/clock';
	import { game } from '$state/game.svelte';

	interface CountdownProps {
		until: number;
		doneLabel?: string;
	}

	const { until, doneLabel = 'ready' }: CountdownProps = $props();

	const remaining = $derived(until - game.now);
</script>

<span class="e-countdown">{remaining > 0 ? formatDuration(remaining) : doneLabel}</span>

<style lang="scss">
	.e-countdown {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
</style>
