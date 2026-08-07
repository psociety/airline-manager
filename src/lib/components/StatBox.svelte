<script lang="ts">
	import type { IconComponent } from './icons';

	interface StatBoxProps {
		icon: IconComponent;
		value: string;
		label: string;
	}

	const { icon: Icon, value, label }: StatBoxProps = $props();
</script>

<div class="e-stat-box">
	<div class="e-stat-box__icon"><Icon size={18} /></div>
	<div>
		<h4 class="e-stat-box__value">{value}</h4>
		<p class="e-stat-box__label">{label}</p>
	</div>
</div>
