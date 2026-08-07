#!/usr/bin/env node
/**
 * Rebuilds the airport dataset from public sources.
 *
 *   npm run data:airports
 *
 * Sources
 *   OurAirports (public domain) — names, IATA/ICAO codes, coordinates, country,
 *   continent, scheduled-service flag and every runway length.
 *   Wikidata (CC0) — annual passenger figures, used to grade tier and gate counts.
 *
 * The generated JSON is committed, so neither the game nor its tests ever need the
 * network. Airports already in the file are preserved verbatim (bar the explicit
 * corrections below) so an existing world keeps its balance.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AIRPORTS_JSON = resolve(HERE, '../src/lib/data/airports_data.json');
const GATES_JSON = resolve(HERE, '../src/lib/data/airport_gates.json');

const OURAIRPORTS = 'https://davidmegginson.github.io/ourairports-data';
const WIKIDATA = 'https://query.wikidata.org/sparql';

/** How many airports the finished file should hold. */
const TARGET_TOTAL = 300;

/**
 * The original hand-curated hundred. Their entries and their real-world gate counts are
 * kept exactly as they are; everything else in the file is derived from the sources
 * below and rebuilt on every run, which makes this script idempotent — running it twice
 * produces the same 300 airports rather than compounding to 500.
 */
const CURATED_BASELINE = [
	'ATL', 'CDG', 'DXB', 'FRA', 'HKG', 'HND', 'JFK', 'LAX', 'LHR', 'ORD', 'PEK', 'PVG', 'SIN',
	'AMS', 'DFW', 'DOH', 'ICN', 'IST', 'MAD', 'NRT', 'SFO', 'SYD', 'AUH', 'BKK', 'BOM', 'BOS',
	'CAN', 'DEL', 'DEN', 'FCO', 'GRU', 'IAH', 'LGW', 'MEL', 'MIA', 'MUC', 'SEA', 'TPE', 'YYZ',
	'ZRH', 'AKL', 'BCN', 'BNE', 'BOG', 'BRU', 'CAI', 'CGK', 'CLT', 'CPH', 'DTW', 'DUB', 'EZE',
	'GIG', 'JNB', 'KUL', 'LAS', 'MAN', 'MCO', 'MEX', 'MSP', 'MXP', 'PHL', 'PHX', 'SCL', 'SZX',
	'TXL', 'VIE', 'YVR', 'ADD', 'ARN', 'BUD', 'CMN', 'CPT', 'HAN', 'HEL', 'LIM', 'LOS', 'MCT',
	'MNL', 'NBO', 'OSL', 'PER', 'PRG', 'SNA', 'WAW', 'YUL', 'ACC', 'ADL', 'ALG', 'CCS', 'CHC',
	'CNS', 'DAR', 'DKR', 'OOL', 'TUN', 'UIO', 'WLG', 'ASU', 'SAL'
];

/** Floors an airport must clear to be worth flying to in the game. */
const MIN_RUNWAY_M = 1800;
const MIN_ANNUAL_PASSENGERS = 500_000;

/** Always include these, whatever the ranking says. */
const FORCE_INCLUDE = ['BER'];

/**
 * Corrections to entries already in the file, verified against OurAirports.
 * Tegel (TXL) closed in 2020 but stays in the dataset: `getAirport` throws on an
 * unknown code, so removing it would break any save holding a gate there.
 */
const CORRECTIONS = {
	PHL: { runwayLength: 3658 },
	BUD: { runwayLength: 3707 },
	DKR: { latitude: 14.671, longitude: -17.072 }
};

/* ------------------------------------------------------------------ fetching */

const fetchText = async (url) => {
	const response = await fetch(url, { headers: { 'user-agent': 'airline-manager-sim/1.0' } });
	if (!response.ok) throw new Error(`${url} responded ${response.status}`);
	return response.text();
};

const fetchPassengerFigures = async () => {
	const query = `SELECT ?iata (MAX(?pax) AS ?passengers) WHERE {
		?airport wdt:P238 ?iata; wdt:P3872 ?pax.
	} GROUP BY ?iata`;

	const response = await fetch(`${WIKIDATA}?query=${encodeURIComponent(query)}`, {
		headers: {
			accept: 'application/sparql-results+json',
			'user-agent': 'airline-manager-sim/1.0'
		}
	});
	if (!response.ok) throw new Error(`Wikidata responded ${response.status}`);

	const body = await response.json();
	const figures = new Map();
	for (const row of body.results.bindings) {
		figures.set(row.iata.value, Number(row.passengers.value));
	}
	return figures;
};

/** Minimal RFC 4180 parser — the source quotes any field containing a comma. */
const parseCsv = (text) => {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];

		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else quoted = false;
			} else field += char;
			continue;
		}

		if (char === '"') quoted = true;
		else if (char === ',') {
			row.push(field);
			field = '';
		} else if (char === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else if (char !== '\r') field += char;
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	const [header, ...body] = rows;
	return body
		.filter((line) => line.length === header.length)
		.map((line) => Object.fromEntries(header.map((key, index) => [key, line[index]])));
};

/* ---------------------------------------------------------------- derivation */

const CONTINENTS = {
	AF: 'Africa',
	AN: 'Antarctica',
	AS: 'Asia',
	EU: 'Europe',
	NA: 'North America',
	OC: 'Oceania',
	SA: 'South America'
};

const feetToMetres = (feet) => Math.round(feet * 0.3048);

/**
 * Tier from real traffic, banded to reproduce the grading of the original hundred
 * (whose tiers are left untouched). Drives demand and gate prices.
 */
const tierForTraffic = (annualPassengers) => {
	const millions = annualPassengers / 1e6;
	if (millions >= 70) return 10;
	if (millions >= 45) return 9;
	if (millions >= 35) return 8;
	if (millions >= 22) return 7;
	if (millions >= 12) return 6;
	if (millions >= 4) return 5;
	return 4;
};

/** The tier→price mapping the original file uses. Unread by the game today. */
const HUB_PRICE_BY_TIER = {
	10: 550_000_000,
	9: 480_000_000,
	8: 400_000_000,
	7: 300_000_000,
	6: 220_000_000,
	5: 150_000_000,
	4: 100_000_000
};

/** Departure charges, interpolated across the ranges the original file spans. */
const feesForTier = (tier) => ({
	landingFeePerTon: Number((3 + ((tier - 4) / 6) * 8).toFixed(1)),
	passengerFee: Number((9 + ((tier - 4) / 6) * 26).toFixed(1))
});

/**
 * Demand character. There is no public dataset for how touristic or business-driven
 * an airport is, so this is a game value: the continent's average across the original
 * hundred, nudged deterministically per airport, with a hand-picked uplift for the
 * obvious holiday gateways.
 */
const LEISURE_GATEWAYS = new Set([
	'PMI', 'AYT', 'CUN', 'HRG', 'SSH', 'DPS', 'HKT', 'IBZ', 'AGP', 'TFS', 'LPA', 'ACE',
	'RAK', 'MLE', 'PUJ', 'MBJ', 'NAN', 'PPT', 'CHQ', 'HER', 'RHO', 'JTR', 'FAO', 'SPU',
	'DBV', 'ZTH', 'KOS', 'CFU', 'BJV', 'NLU', 'SJD', 'PVR', 'LIR', 'AUA', 'CUR', 'UVF'
]);
const BUSINESS_HUBS = new Set([
	'EWR', 'LGA', 'DME', 'SVO', 'ORY', 'LCY', 'HND', 'SHA', 'GMP', 'TSN', 'RUH', 'JED',
	'TLV', 'KWI', 'BAH', 'DOH', 'BOM', 'BLR', 'MAA', 'HYD', 'CGN', 'STR', 'GVA', 'LUX'
]);

/** Stable per-airport jitter so a rerun produces byte-identical output. */
const hash = (value) => {
	let result = 2166136261;
	for (const char of value) {
		result ^= char.charCodeAt(0);
		result = Math.imul(result, 16777619);
	}
	return (result >>> 0) / 4294967296;
};

const demandModifiersFor = (iata, continentAverages, continent) => {
	const base = continentAverages[continent] ?? { tourism: 1.2, business: 1.2, cargo: 1.1 };
	const jitter = (salt) => (hash(`${iata}:${salt}`) - 0.5) * 0.3;

	let tourism = base.tourism + jitter('tourism');
	let business = base.business + jitter('business');
	if (LEISURE_GATEWAYS.has(iata)) tourism += 0.45;
	if (BUSINESS_HUBS.has(iata)) business += 0.35;

	const clamp = (value) => Number(Math.min(2, Math.max(0.7, value)).toFixed(1));
	return {
		tourism: clamp(tourism),
		business: clamp(business),
		cargo: clamp(base.cargo + jitter('cargo'))
	};
};

/**
 * The source's `municipality` is sometimes the district or village the airport sits in
 * rather than the city players would look for — Athens is filed under Spata-Artemida,
 * Ljubljana under Zgornji Brnik. City names also follow the file's existing English
 * convention (Rome, Milan), so Napoli becomes Naples.
 */
const CITY_OVERRIDES = {
	ANU: "St John's", ATH: 'Athens', BGY: 'Bergamo', CSX: 'Changsha', CTU: 'Chengdu',
	DPS: 'Denpasar', EDI: 'Edinburgh', HAK: 'Haikou', HNL: 'Honolulu', IOM: 'Douglas',
	KOS: 'Sihanoukville', LIN: 'Milan', LJU: 'Ljubljana', LPA: 'Las Palmas', LTN: 'London',
	MFM: 'Macau', MRU: 'Port Louis', MVD: 'Montevideo', NAP: 'Naples', NCE: 'Nice',
	ORY: 'Paris', OTP: 'Bucharest', RUN: 'Saint-Denis', SAW: 'Istanbul', SHA: 'Shanghai',
	SID: 'Sal', SJO: 'San José', SKP: 'Skopje', SPN: 'Saipan', STN: 'London',
	TAO: 'Qingdao', TFU: 'Chengdu', TIA: 'Tirana', TNA: 'Jinan', VCE: 'Venice',
	WNZ: 'Wenzhou', WUH: 'Wuhan', ZAG: 'Zagreb', ZUH: 'Zhuhai'
};

/**
 * Gate count fitted on the hand-curated real-world counts of the original hundred
 * (median error 20%: ATL 188 vs 192, DFW 170 vs 174, ASU 7 vs 8). Only ever applied
 * to newly added airports — the curated counts are kept as they are.
 */
const gatesFor = (annualPassengers, runwayCount) => {
	const millions = Math.max(annualPassengers / 1e6, 0.05);
	return Math.max(6, Math.round(7.66 * millions ** 0.664 * (runwayCount / 2) ** 0.1));
};

/**
 * IANA zone. The game runs in UTC and never reads this field, so a country-level zone
 * is enough; the few countries that genuinely span zones are split by longitude.
 */
const ZONE_BY_LONGITUDE = {
	US: [[-125, 'America/Los_Angeles'], [-115, 'America/Denver'], [-100, 'America/Chicago'], [0, 'America/New_York']],
	CA: [[-125, 'America/Vancouver'], [-110, 'America/Edmonton'], [-95, 'America/Winnipeg'], [-60, 'America/Toronto'], [0, 'America/Halifax']],
	RU: [[30, 'Europe/Moscow'], [60, 'Asia/Yekaterinburg'], [90, 'Asia/Krasnoyarsk'], [120, 'Asia/Irkutsk'], [180, 'Asia/Vladivostok']],
	BR: [[-60, 'America/Manaus'], [0, 'America/Sao_Paulo']],
	AU: [[125, 'Australia/Perth'], [138, 'Australia/Darwin'], [180, 'Australia/Sydney']],
	MX: [[-110, 'America/Tijuana'], [-100, 'America/Chihuahua'], [0, 'America/Mexico_City']],
	ID: [[110, 'Asia/Jakarta'], [125, 'Asia/Makassar'], [180, 'Asia/Jayapura']],
	KZ: [[65, 'Asia/Aqtobe'], [180, 'Asia/Almaty']],
	CD: [[20, 'Africa/Kinshasa'], [180, 'Africa/Lubumbashi']],
	ES: [[-10, 'Atlantic/Canary'], [180, 'Europe/Madrid']],
	PT: [[-20, 'Atlantic/Azores'], [-14, 'Atlantic/Madeira'], [180, 'Europe/Lisbon']],
	EC: [[-85, 'Pacific/Galapagos'], [180, 'America/Guayaquil']],
	CL: [[-100, 'Pacific/Easter'], [180, 'America/Santiago']]
};

const ZONE_BY_COUNTRY = {
	AE: 'Asia/Dubai', AF: 'Asia/Kabul', AG: 'America/Antigua', AL: 'Europe/Tirane',
	AM: 'Asia/Yerevan',
	AO: 'Africa/Luanda', AR: 'America/Argentina/Buenos_Aires', AT: 'Europe/Vienna',
	AW: 'America/Aruba', AZ: 'Asia/Baku', BA: 'Europe/Sarajevo', BB: 'America/Barbados',
	BD: 'Asia/Dhaka', BE: 'Europe/Brussels', BF: 'Africa/Ouagadougou', BG: 'Europe/Sofia',
	BH: 'Asia/Bahrain', BI: 'Africa/Bujumbura', BJ: 'Africa/Porto-Novo', BM: 'Atlantic/Bermuda',
	BN: 'Asia/Brunei', BO: 'America/La_Paz', BS: 'America/Nassau', BW: 'Africa/Gaborone',
	BY: 'Europe/Minsk', BZ: 'America/Belize', CG: 'Africa/Brazzaville', CH: 'Europe/Zurich',
	CI: 'Africa/Abidjan', CM: 'Africa/Douala', CN: 'Asia/Shanghai', CO: 'America/Bogota',
	CR: 'America/Costa_Rica', CU: 'America/Havana', CV: 'Atlantic/Cape_Verde',
	CW: 'America/Curacao', CY: 'Asia/Nicosia', CZ: 'Europe/Prague', DE: 'Europe/Berlin',
	DJ: 'Africa/Djibouti', DK: 'Europe/Copenhagen', DO: 'America/Santo_Domingo',
	DZ: 'Africa/Algiers', EE: 'Europe/Tallinn', EG: 'Africa/Cairo', ER: 'Africa/Asmara',
	ET: 'Africa/Addis_Ababa', FI: 'Europe/Helsinki', FJ: 'Pacific/Fiji', FR: 'Europe/Paris',
	GA: 'Africa/Libreville', GB: 'Europe/London', GP: 'America/Guadeloupe', GE: 'Asia/Tbilisi', GH: 'Africa/Accra',
	GM: 'Africa/Banjul', GN: 'Africa/Conakry', GQ: 'Africa/Malabo', GR: 'Europe/Athens',
	GT: 'America/Guatemala', GU: 'Pacific/Guam', GY: 'America/Guyana', HK: 'Asia/Hong_Kong',
	HN: 'America/Tegucigalpa', HR: 'Europe/Zagreb', KY: 'America/Cayman', HT: 'America/Port-au-Prince',
	HU: 'Europe/Budapest', IE: 'Europe/Dublin', IL: 'Asia/Jerusalem', IM: 'Europe/Isle_of_Man',
	IN: 'Asia/Kolkata', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', IS: 'Atlantic/Reykjavik',
	IT: 'Europe/Rome', JM: 'America/Jamaica', JO: 'Asia/Amman', JP: 'Asia/Tokyo',
	KE: 'Africa/Nairobi', KG: 'Asia/Bishkek', KH: 'Asia/Phnom_Penh', KR: 'Asia/Seoul',
	KW: 'Asia/Kuwait', LA: 'Asia/Vientiane', LC: 'America/St_Lucia', LB: 'Asia/Beirut', LK: 'Asia/Colombo',
	LR: 'Africa/Monrovia', LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', LV: 'Europe/Riga',
	LY: 'Africa/Tripoli', MA: 'Africa/Casablanca', MD: 'Europe/Chisinau', ME: 'Europe/Podgorica',
	MG: 'Indian/Antananarivo', MK: 'Europe/Skopje', ML: 'Africa/Bamako', MM: 'Asia/Yangon',
	MN: 'Asia/Ulaanbaatar', MO: 'Asia/Macau', MP: 'Pacific/Saipan', MQ: 'America/Martinique', MR: 'Africa/Nouakchott', MT: 'Europe/Malta',
	MU: 'Indian/Mauritius', MV: 'Indian/Maldives', MW: 'Africa/Blantyre', MY: 'Asia/Kuala_Lumpur',
	MZ: 'Africa/Maputo', NA: 'Africa/Windhoek', NC: 'Pacific/Noumea', NG: 'Africa/Lagos',
	NI: 'America/Managua', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', NP: 'Asia/Kathmandu',
	NZ: 'Pacific/Auckland', OM: 'Asia/Muscat', PA: 'America/Panama', PE: 'America/Lima',
	PF: 'Pacific/Tahiti', PG: 'Pacific/Port_Moresby', PH: 'Asia/Manila', PK: 'Asia/Karachi',
	PL: 'Europe/Warsaw', PR: 'America/Puerto_Rico', PY: 'America/Asuncion', QA: 'Asia/Qatar',
	RE: 'Indian/Reunion', RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', RW: 'Africa/Kigali',
	SA: 'Asia/Riyadh', SC: 'Indian/Mahe', SD: 'Africa/Khartoum', SE: 'Europe/Stockholm',
	SG: 'Asia/Singapore', SI: 'Europe/Ljubljana', SK: 'Europe/Bratislava', SL: 'Africa/Freetown',
	SN: 'Africa/Dakar', SO: 'Africa/Mogadishu', SR: 'America/Paramaribo', SV: 'America/El_Salvador',
	SX: 'America/Lower_Princes', SY: 'Asia/Damascus', SZ: 'Africa/Mbabane', TD: "Africa/Ndjamena", TG: 'Africa/Lome',
	TH: 'Asia/Bangkok', TJ: 'Asia/Dushanbe', TM: 'Asia/Ashgabat', TN: 'Africa/Tunis',
	TR: 'Europe/Istanbul', TT: 'America/Port_of_Spain', TW: 'Asia/Taipei', TZ: 'Africa/Dar_es_Salaam',
	UA: 'Europe/Kyiv', UG: 'Africa/Kampala', XK: 'Europe/Belgrade', UY: 'America/Montevideo', UZ: 'Asia/Tashkent',
	VE: 'America/Caracas', VI: 'America/St_Thomas', VN: 'Asia/Ho_Chi_Minh', YE: 'Asia/Aden', ZA: 'Africa/Johannesburg',
	ZM: 'Africa/Lusaka', ZW: 'Africa/Harare'
};

const timezoneFor = (countryCode, longitude) => {
	const bands = ZONE_BY_LONGITUDE[countryCode];
	if (bands) {
		for (const [limit, zone] of bands) if (longitude < limit) return zone;
		return bands[bands.length - 1][1];
	}
	return ZONE_BY_COUNTRY[countryCode] ?? 'UTC';
};

/* ---------------------------------------------------------------------- main */

const main = async () => {
	const existingFile = JSON.parse(readFileSync(AIRPORTS_JSON, 'utf8'));
	const gatesFile = JSON.parse(readFileSync(GATES_JSON, 'utf8'));

	const baselineCodes = new Set(CURATED_BASELINE);
	const existing = existingFile.airports.filter((airport) => baselineCodes.has(airport.iataCode));
	if (existing.length !== CURATED_BASELINE.length) {
		throw new Error(
			`expected the ${CURATED_BASELINE.length} curated airports in the file, found ${existing.length}`
		);
	}

	const existingCodes = new Set(existing.map((airport) => airport.iataCode));
	const existingCountries = new Set(existing.map((airport) => airport.countryCode));
	const nameByCountryCode = new Map(
		existing.map((airport) => [airport.countryCode, airport.country])
	);

	console.log('Fetching sources…');
	const [airportsCsv, runwaysCsv, passengers] = await Promise.all([
		fetchText(`${OURAIRPORTS}/airports.csv`),
		fetchText(`${OURAIRPORTS}/runways.csv`),
		fetchPassengerFigures()
	]);
	console.log(`  passenger figures for ${passengers.size} airports`);

	const runwayRows = parseCsv(runwaysCsv);
	const runwayCount = new Map();
	const longestRunway = new Map();
	for (const runway of runwayRows) {
		if (runway.closed === '1') continue;
		const ident = runway.airport_ident;
		runwayCount.set(ident, (runwayCount.get(ident) ?? 0) + 1);
		const length = Number(runway.length_ft);
		if (Number.isFinite(length) && length > 0) {
			longestRunway.set(ident, Math.max(longestRunway.get(ident) ?? 0, length));
		}
	}

	const sourceRows = parseCsv(airportsCsv);
	const sourceByIata = new Map();
	for (const airport of sourceRows) {
		if (airport.iata_code) sourceByIata.set(airport.iata_code, airport);
	}

	// Continent averages for the demand character, taken from the original hundred.
	const continentTotals = {};
	for (const airport of existing) {
		const bucket = (continentTotals[airport.continent] ??= {
			tourism: 0,
			business: 0,
			cargo: 0,
			count: 0
		});
		bucket.tourism += airport.demandModifiers.tourism;
		bucket.business += airport.demandModifiers.business;
		bucket.cargo += airport.demandModifiers.cargo;
		bucket.count += 1;
	}
	const continentAverages = Object.fromEntries(
		Object.entries(continentTotals).map(([continent, bucket]) => [
			continent,
			{
				tourism: bucket.tourism / bucket.count,
				business: bucket.business / bucket.count,
				cargo: bucket.cargo / bucket.count
			}
		])
	);

	// Candidates: real commercial airports we do not already have.
	const candidates = [];
	for (const [iata, source] of sourceByIata) {
		if (existingCodes.has(iata)) continue;
		if (source.scheduled_service !== 'yes') continue;
		if (!['large_airport', 'medium_airport'].includes(source.type)) continue;

		const runwayFeet = longestRunway.get(source.ident);
		const annualPassengers = passengers.get(iata);
		if (!runwayFeet || !annualPassengers) continue;
		if (feetToMetres(runwayFeet) < MIN_RUNWAY_M) continue;
		if (annualPassengers < MIN_ANNUAL_PASSENGERS && !FORCE_INCLUDE.includes(iata)) continue;
		if (!CONTINENTS[source.continent] || source.continent === 'AN') continue;
		if (!ZONE_BY_COUNTRY[source.iso_country] && !ZONE_BY_LONGITUDE[source.iso_country]) {
			continue; // no timezone for this country: leave it out rather than guess
		}

		candidates.push({
			iata,
			source,
			annualPassengers,
			runwayMetres: feetToMetres(runwayFeet),
			runways: runwayCount.get(source.ident) ?? 1
		});
	}
	candidates.sort((left, right) => right.annualPassengers - left.annualPassengers);
	console.log(`  ${candidates.length} candidates clear the floors`);

	// Breadth first: every country we do not serve gets its busiest airport, then the
	// remaining slots go to the busiest airports left anywhere.
	const chosen = [];
	const takenCountries = new Set();
	for (const candidate of candidates) {
		const country = candidate.source.iso_country;
		if (existingCountries.has(country) || takenCountries.has(country)) continue;
		chosen.push(candidate);
		takenCountries.add(country);
	}
	console.log(`  ${chosen.length} countries added by the breadth-first pass`);

	for (const iata of FORCE_INCLUDE) {
		const forced = candidates.find((candidate) => candidate.iata === iata);
		if (forced && !chosen.includes(forced)) chosen.push(forced);
	}
	for (const candidate of candidates) {
		if (chosen.length >= TARGET_TOTAL - existing.length) break;
		if (!chosen.includes(candidate)) chosen.push(candidate);
	}

	const additions = chosen.slice(0, TARGET_TOTAL - existing.length).map((candidate) => {
		const { iata, source, annualPassengers, runwayMetres, runways } = candidate;
		const continent = CONTINENTS[source.continent];
		const tier = tierForTraffic(annualPassengers);
		const { landingFeePerTon, passengerFee } = feesForTier(tier);

		return {
			airport: {
				iataCode: iata,
				icaoCode: source.icao_code || source.ident,
				name: source.name,
				city: CITY_OVERRIDES[iata] ?? source.municipality ?? source.name,
				country:
					nameByCountryCode.get(source.iso_country) ??
					new Intl.DisplayNames(['en'], { type: 'region' }).of(source.iso_country),
				countryCode: source.iso_country,
				continent,
				latitude: Number(Number(source.latitude_deg).toFixed(4)),
				longitude: Number(Number(source.longitude_deg).toFixed(4)),
				tier,
				runwayLength: runwayMetres,
				isHubPurchasable: true,
				hubPrice: HUB_PRICE_BY_TIER[tier],
				landingFeePerTon,
				passengerFee,
				timezone: timezoneFor(source.iso_country, Number(source.longitude_deg)),
				demandModifiers: demandModifiersFor(iata, continentAverages, continent)
			},
			gates: gatesFor(annualPassengers, runways)
		};
	});

	// Apply the verified corrections to the airports already in the file.
	const corrected = existing.map((airport) =>
		CORRECTIONS[airport.iataCode] ? { ...airport, ...CORRECTIONS[airport.iataCode] } : airport
	);

	const airports = [...corrected, ...additions.map((entry) => entry.airport)];
	writeFileSync(
		AIRPORTS_JSON,
		`${JSON.stringify({ count: airports.length, airports }, null, 2)}\n`
	);

	const gateCounts = {};
	for (const code of CURATED_BASELINE) gateCounts[code] = gatesFile.gateCounts[code];
	for (const entry of additions) gateCounts[entry.airport.iataCode] = entry.gates;
	writeFileSync(
		GATES_JSON,
		`${JSON.stringify({ _comment: gatesFile._comment, gateCounts }, null, 2)}\n`
	);

	const countries = new Set(airports.map((airport) => airport.countryCode));
	const totalGates = Object.values(gateCounts).reduce((sum, count) => sum + count, 0);
	console.log(
		`\nWrote ${airports.length} airports (${additions.length} added) across ` +
			`${countries.size} countries; ${totalGates} gates world-wide.`
	);
	for (const iata of Object.keys(CORRECTIONS)) console.log(`  corrected ${iata}`);
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
