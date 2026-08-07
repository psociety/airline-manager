const EARTH_RADIUS_KM = 6371;

export interface Coordinates {
	latitude: number;
	longitude: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/** Great-circle distance in kilometres. */
export const distanceKm = (from: Coordinates, to: Coordinates): number => {
	const fromLat = toRadians(from.latitude);
	const toLat = toRadians(to.latitude);
	const deltaLat = toLat - fromLat;
	const deltaLon = toRadians(to.longitude - from.longitude);

	const haversine =
		Math.sin(deltaLat / 2) ** 2 +
		Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;

	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine)));
};

/** Initial great-circle heading in degrees, 0 = north. */
export const bearing = (from: Coordinates, to: Coordinates): number => {
	const fromLat = toRadians(from.latitude);
	const toLat = toRadians(to.latitude);
	const deltaLon = toRadians(to.longitude - from.longitude);

	const y = Math.sin(deltaLon) * Math.cos(toLat);
	const x =
		Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);

	return (toDegrees(Math.atan2(y, x)) + 360) % 360;
};

/** Point at `fraction` (0..1) along the great circle between two coordinates. */
export const interpolate = (from: Coordinates, to: Coordinates, fraction: number): Coordinates => {
	const fromLat = toRadians(from.latitude);
	const fromLon = toRadians(from.longitude);
	const toLat = toRadians(to.latitude);
	const toLon = toRadians(to.longitude);

	const angular = distanceKm(from, to) / EARTH_RADIUS_KM;
	if (angular === 0) return { latitude: from.latitude, longitude: from.longitude };

	const sinAngular = Math.sin(angular);
	const fromWeight = Math.sin((1 - fraction) * angular) / sinAngular;
	const toWeight = Math.sin(fraction * angular) / sinAngular;

	const x = fromWeight * Math.cos(fromLat) * Math.cos(fromLon) + toWeight * Math.cos(toLat) * Math.cos(toLon);
	const y = fromWeight * Math.cos(fromLat) * Math.sin(fromLon) + toWeight * Math.cos(toLat) * Math.sin(toLon);
	const z = fromWeight * Math.sin(fromLat) + toWeight * Math.sin(toLat);

	return {
		latitude: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
		longitude: toDegrees(Math.atan2(y, x))
	};
};

/** Polyline points for drawing a great-circle route on a map. */
export const greatCirclePoints = (
	from: Coordinates,
	to: Coordinates,
	segments = 48
): [number, number][] => {
	const points: [number, number][] = [];
	for (let index = 0; index <= segments; index += 1) {
		const point = interpolate(from, to, index / segments);
		points.push([point.latitude, point.longitude]);
	}
	return points;
};
