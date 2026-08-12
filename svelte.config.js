import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			fallback: 'index.html',
			precompress: false,
			strict: false
		}),
		// GitHub Pages serves a project repo from /<repo>/, so every link and asset needs that
		// prefix baked in at build time. Locally BASE_PATH is unset and the app lives at the root.
		paths: {
			base: process.env.BASE_PATH ?? ''
		},
		alias: {
			$data: 'src/lib/data',
			$db: 'src/lib/db',
			$engine: 'src/lib/engine',
			$state: 'src/lib/state',
			$components: 'src/lib/components'
		}
	}
};

export default config;
