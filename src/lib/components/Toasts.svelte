<script lang="ts">
	import { game } from '$state/game.svelte';
</script>

<div class="e-toasts">
	{#each game.toasts as toast (toast.id)}
		<button
			class="e-toast e-toast--{toast.kind}"
			type="button"
			onclick={() => game.dismiss(toast.id)}
		>
			{toast.message}
		</button>
	{/each}
</div>

<style lang="scss">
	.e-toast {
		text-align: left;
		border-top: none;
		border-right: none;
		border-bottom: none;
		cursor: pointer;
	}
</style>
