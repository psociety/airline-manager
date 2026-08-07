<script lang="ts">
	import { formatCompactMoney, formatMoney } from '$engine/economy';

	interface MoneyProps {
		amount: number;
		compact?: boolean;
		signed?: boolean;
		colour?: boolean;
	}

	const { amount, compact = false, signed = false, colour = false }: MoneyProps = $props();

	const formatted = $derived(compact ? formatCompactMoney(amount) : formatMoney(amount));
	const display = $derived(signed && amount > 0 ? `+${formatted}` : formatted);
</script>

<span
	class="e-money"
	class:e-money--positive={colour && amount > 0}
	class:e-money--negative={colour && amount < 0}>{display}</span
>
