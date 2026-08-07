import type { Icon } from 'lucide-svelte';

/**
 * Every lucide icon shares the shape of the package's own `Icon` component, so
 * deriving the type from it keeps icon props typed without guessing at internals.
 */
export type IconComponent = typeof Icon;
