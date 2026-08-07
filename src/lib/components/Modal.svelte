<script lang="ts">
	import { X } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	interface ModalProps {
		title: string;
		wide?: boolean;
		onClose: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	const { title, wide = false, onClose, children, footer }: ModalProps = $props();

	const handleKeydown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') onClose();
	};
</script>

<svelte:window on:keydown={handleKeydown} />

<div
	class="e-modal"
	role="button"
	tabindex="-1"
	onclick={(event) => {
		if (event.target === event.currentTarget) onClose();
	}}
	onkeydown={() => {}}
>
	<div class="e-modal__dialog" class:e-modal__dialog--wide={wide}>
		<header class="e-modal__header">
			<h2 class="e-modal__title">{title}</h2>
			<button class="e-modal__close" type="button" onclick={onClose} aria-label="Close">
				<X size={18} />
			</button>
		</header>
		<div class="e-modal__body">
			{@render children()}
		</div>
		{#if footer}
			<footer class="e-modal__footer">
				{@render footer()}
			</footer>
		{/if}
	</div>
</div>
