<script lang="ts">
	import type { IconComponent } from './icons';

	interface ProgressBarProps {
		label: string;
		/** 0..1, values above 1 are clamped for the bar but still colour it red. */
		value: number;
		icon?: IconComponent;
		tone?: 'auto' | 'green' | 'yellow' | 'red';
	}

	const { label, value, icon: Icon, tone = 'auto' }: ProgressBarProps = $props();

	const width = $derived(Math.max(0, Math.min(1, value)) * 100);
	const resolvedTone = $derived(
		tone !== 'auto' ? tone : value >= 0.9 ? 'red' : value >= 0.65 ? 'yellow' : 'green'
	);
</script>

<div class="e-metric-bar">
	<div class="e-metric-bar__label">
		{#if Icon}<Icon size={12} />{/if}
		{label}
	</div>
	<div class="e-metric-bar__track">
		<div
			class="e-metric-bar__fill e-metric-bar__fill--{resolvedTone}"
			style:width="{width}%"
		></div>
	</div>
</div>
