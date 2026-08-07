import airportsData from './airports_data.json';
import type { Airport } from './types';

export const AIRPORTS: Airport[] = (airportsData as { airports: Airport[] }).airports;

const airportsByIata = new Map<string, Airport>(
	AIRPORTS.map((airport) => [airport.iataCode, airport])
);

/** Lookup that tolerates an unknown code, for validating data that came from a save. */
export const findAirport = (iataCode: string): Airport | undefined => airportsByIata.get(iataCode);

export const getAirport = (iataCode: string): Airport => {
	const airport = airportsByIata.get(iataCode);
	if (!airport) throw new Error(`Unknown airport: ${iataCode}`);
	return airport;
};

export interface CountryGroup {
	country: string;
	countryCode: string;
	continent: string;
	airports: Airport[];
}

export const COUNTRIES: CountryGroup[] = (() => {
	const groups = new Map<string, CountryGroup>();

	for (const airport of AIRPORTS) {
		const group = groups.get(airport.country);
		if (group) {
			group.airports.push(airport);
			continue;
		}
		groups.set(airport.country, {
			country: airport.country,
			countryCode: airport.countryCode,
			continent: airport.continent,
			airports: [airport]
		});
	}

	const sorted = [...groups.values()].sort((left, right) =>
		left.country.localeCompare(right.country)
	);
	for (const group of sorted) {
		group.airports.sort((left, right) => right.tier - left.tier);
	}
	return sorted;
})();
