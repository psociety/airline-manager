#!/usr/bin/env node
/**
 * Extracts the freighter catalogue from the saved aircraft-market page.
 *
 *   npm run data:cargo
 *
 * Reads `cargo_airplanes.html`, writes `src/lib/data/cargo_aircraft_data.json` in the
 * same shape as the passenger dataset, and downloads each aircraft's illustration into
 * `static/aircraft/`. Both outputs are committed, so the game never needs the network.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '../cargo_airplanes.html');
const OUTPUT = resolve(HERE, '../src/lib/data/cargo_aircraft_data.json');
const IMAGE_DIR = resolve(HERE, '../static/aircraft');
const MANIFEST = resolve(HERE, '../src/lib/data/aircraft_images.json');

const decode = (value) =>
	value
		.replace(/&quot;/g, '"')
		.replace(/&#149;/g, '·')
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.trim();

const attribute = (block, name) => {
	const match = block.match(new RegExp(`data-${name}="([^"]+)"`));
	return match ? match[1] : null;
};

const labelled = (block, label) => {
	const match = block.match(new RegExp(`${label}\\s*:\\s*<b>\\s*([\\d.,]+)`));
	return match ? Number(match[1].replace(/,/g, '')) : null;
};

const parse = (html) => {
	const blocks = html.match(
		/<div class="aircraftPurchaseBox[\s\S]*?(?=<div class="aircraftPurchaseBox|<div id="pagination|$)/g
	);
	if (!blocks) throw new Error('no aircraft found in the page');

	return blocks.map((block) => {
		const json = JSON.parse(
			decode(block.match(/class="hidden aircraftJson">([\s\S]*?)<\/div>/)[1])
		);
		const title = block.match(/<span>\s*([^<]+?)\s*\/\s*([^<]+?)\s*<\/span>/);
		const image = block.match(/data-big="([^"]+)"/);
		const imageUrl = image ? image[1] : null;
		const imageName = imageUrl ? imageUrl.split('/').pop().split('?')[0] : null;

		if (!block.includes('cargoBtn')) {
			throw new Error(`${title?.[1]} is not marked as a freighter`);
		}

		return {
			id: json.id,
			name: decode(title[1]),
			manufacturer: decode(title[2]),
			category: json.category,
			speed: Number(attribute(block, 'speed')),
			range: Number(attribute(block, 'range')),
			seats: 0,
			payload: Number(attribute(block, 'payload')),
			consumption: labelled(block, 'Consum\\.'),
			wear_speed: labelled(block, 'Wear speed'),
			introduction_year: labelled(block, 'Introduction'),
			price: Number(attribute(block, 'price')),
			unlocked: true,
			image_name: imageName ? imageName.replace(/\.png$/i, '') : '',
			big_image_url: imageUrl ?? ''
		};
	});
};

const download = async (aircraft) => {
	if (!aircraft.big_image_url) return false;

	const file = resolve(IMAGE_DIR, `${aircraft.image_name}.png`);
	if (existsSync(file)) return false;

	const response = await fetch(aircraft.big_image_url);
	if (!response.ok) {
		console.warn(`  ${aircraft.name}: image responded ${response.status}`);
		return false;
	}

	writeFileSync(file, Buffer.from(await response.arrayBuffer()));
	return true;
};

const main = async () => {
	const aircraft = parse(readFileSync(SOURCE, 'utf8'));

	const missingSpec = aircraft.filter(
		(model) =>
			!model.name ||
			!model.speed ||
			!model.range ||
			!model.payload ||
			!model.consumption ||
			!model.wear_speed ||
			!model.price
	);
	if (missingSpec.length > 0) {
		throw new Error(`incomplete specs for ${missingSpec.map((m) => m.name).join(', ')}`);
	}

	aircraft.sort((left, right) => left.price - right.price);
	writeFileSync(OUTPUT, `${JSON.stringify({ count: aircraft.length, aircraft }, null, 2)}\n`);

	let downloaded = 0;
	for (const model of aircraft) {
		if (await download(model)) downloaded += 1;
	}

	// Keep the image manifest, which resolves names to files, in step.
	const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	const files = new Set(manifest);
	for (const model of aircraft) {
		if (model.image_name && existsSync(resolve(IMAGE_DIR, `${model.image_name}.png`))) {
			files.add(`${model.image_name}.png`);
		}
	}
	writeFileSync(MANIFEST, `${JSON.stringify([...files].sort(), null, '\t')}\n`);

	const withoutImage = aircraft.filter(
		(model) => !existsSync(resolve(IMAGE_DIR, `${model.image_name}.png`))
	);
	console.log(
		`Wrote ${aircraft.length} freighters (${downloaded} images downloaded, ` +
			`${aircraft.length - withoutImage.length} of ${aircraft.length} illustrated).`
	);
	if (withoutImage.length > 0) {
		console.warn(`  no image for: ${withoutImage.map((m) => m.name).join(', ')}`);
	}
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
