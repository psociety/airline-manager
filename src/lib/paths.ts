declare const __BASE_PATH__: string;

/**
 * The path the game is served from — empty when it sits at the root of its host, `/<repo>` when
 * GitHub Pages serves it from a project page. Every link and every asset URL the game writes by
 * hand has to carry it, since only SvelteKit's own generated URLs get it for free.
 *
 * Vite bakes the value in at build time from BASE_PATH, the same variable svelte.config.js reads
 * for `kit.paths.base`.
 */
export const base = __BASE_PATH__;
