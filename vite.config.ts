import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	css: {
		preprocessorOptions: {
			// Vite still defaults to Sass's legacy JS API, which warns on every compile
			// and goes away in Dart Sass 2. The modern compiler API has no such warning.
			scss: { api: 'modern-compiler' }
		}
	},
	// Under Vitest, resolve Svelte's browser build so components can be mounted.
	resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		// Engine tests run in node; component tests opt into a DOM per file.
		environment: 'node',
		environmentMatchGlobs: [['src/lib/components/**', 'jsdom']],
		// Simulation tests drive a real IndexedDB over weeks of game time, and the expensive
		// ones now build one aged world in a `beforeAll` and share it — so a hook can be as
		// slow as the test it replaced, and gets the same budget.
		testTimeout: 60_000,
		hookTimeout: 60_000
	}
});
