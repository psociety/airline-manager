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
