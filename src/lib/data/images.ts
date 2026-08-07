import imageFiles from './aircraft_images.json';
import type { AircraftModel } from './types';

const AIRCRAFT_IMAGE_BASE = '/aircraft/';
export const AIRCRAFT_IMAGE_PLACEHOLDER = '/aircraft-placeholder.svg';

const filesByLowerName = new Map<string, string>(
	(imageFiles as string[]).map((file) => [file.toLowerCase(), file])
);

const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const filesByNormalisedStem = new Map<string, string>();
for (const file of imageFiles as string[]) {
	const stem = file.replace(/\.png$/i, '');
	filesByNormalisedStem.set(normalise(stem), file);
}

export const resolveAircraftImage = (model: AircraftModel): string => {
	if (model.image_name) {
		const exact = filesByLowerName.get(`${model.image_name.toLowerCase()}.png`);
		if (exact) return `${AIRCRAFT_IMAGE_BASE}${exact}`;

		const loose = filesByNormalisedStem.get(normalise(model.image_name));
		if (loose) return `${AIRCRAFT_IMAGE_BASE}${loose}`;
	}

	const byModelName = filesByNormalisedStem.get(normalise(model.name));
	if (byModelName) return `${AIRCRAFT_IMAGE_BASE}${byModelName}`;

	if (model.big_image_url) return model.big_image_url;

	return AIRCRAFT_IMAGE_PLACEHOLDER;
};

/** Falls back to the silhouette when a bundled or remote image fails to load. */
export const onAircraftImageError = (event: Event): void => {
	const image = event.currentTarget as HTMLImageElement | null;
	if (!image || image.src.endsWith(AIRCRAFT_IMAGE_PLACEHOLDER)) return;
	image.src = AIRCRAFT_IMAGE_PLACEHOLDER;
};
