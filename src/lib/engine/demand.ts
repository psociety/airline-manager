import { getAirport } from '$data/airports';
import type { ClassAmounts } from '$data/types';
import { pairKeyOf } from '$db/schema';
import { seededRng } from './rng';

export interface RouteDemand {
	pairKey: string;
	distanceKm: number;
	/** Passengers per day wanting to fly this pair, before competition. */
	dailyDemand: ClassAmounts;
	/** Ticket price the market considers fair for each class. */
	idealPrice: ClassAmounts;
}

export interface Competitor {
	companyId: number;
	companyName: string;
	seatsPerDay: ClassAmounts;
	prices: ClassAmounts;
}

/**
 * Scales an airport pair's combined tiers into daily passengers. Deliberately far
 * below real traffic (BCN–MAD alone carries thousands a day), but high enough that
 * a well-run route covers the 46 ground staff every route carries.
 */
const TIER_WEIGHT = 12;

/** How attractive a distance is for air travel: too short loses to ground, too long is thin. */
const DISTANCE_FACTORS: [number, number][] = [
	[150, 0.35],
	[400, 0.7],
	[900, 1],
	[1800, 0.95],
	[4000, 0.8],
	[8000, 0.55],
	[13000, 0.35],
	[20000, 0.25]
];

export const distanceFactor = (distance: number): number => {
	if (distance <= DISTANCE_FACTORS[0][0]) return DISTANCE_FACTORS[0][1];

	for (let index = 1; index < DISTANCE_FACTORS.length; index += 1) {
		const [upperDistance, upperFactor] = DISTANCE_FACTORS[index];
		if (distance > upperDistance) continue;

		const [lowerDistance, lowerFactor] = DISTANCE_FACTORS[index - 1];
		const progress = (distance - lowerDistance) / (upperDistance - lowerDistance);
		return lowerFactor + (upperFactor - lowerFactor) * progress;
	}

	return DISTANCE_FACTORS[DISTANCE_FACTORS.length - 1][1];
};

/**
 * Fair economy fare: high per-km on short hops, tapering on long haul.
 * Calibrated so a well-utilised route covers its 46-strong ground staff:
 * ~85 € for 500 km, ~125 € for 1.000 km, ~770 € for 10.000 km.
 */
export const idealEconomyPrice = (distance: number): number =>
	Math.round(45 + 0.115 * distance ** 0.95);

const CLASS_PRICE_MULTIPLIER = { economy: 1, business: 2.7, first: 5.2 } as const;

export const idealPrices = (distance: number): ClassAmounts => {
	const economy = idealEconomyPrice(distance);
	return {
		economy,
		business: Math.round(economy * CLASS_PRICE_MULTIPLIER.business),
		first: Math.round(economy * CLASS_PRICE_MULTIPLIER.first)
	};
};

/**
 * Demand for an airport pair. Deterministic: the same pair always yields the same
 * numbers, which is what makes a one-off route audit meaningful. Competition is
 * layered on top at flight time, never baked in here.
 */
export const routeDemand = (fromIata: string, toIata: string, distance: number): RouteDemand => {
	const from = getAirport(fromIata);
	const to = getAirport(toIata);
	const pairKey = pairKeyOf(fromIata, toIata);
	const rng = seededRng('demand', pairKey);

	const tourism = (from.demandModifiers.tourism + to.demandModifiers.tourism) / 2;
	const business = (from.demandModifiers.business + to.demandModifiers.business) / 2;

	const base =
		from.tier * to.tier * TIER_WEIGHT * distanceFactor(distance) * (0.75 + rng() * 0.6);

	const economyWeight = 0.78 * tourism;
	const businessWeight = 0.16 * business;
	const firstWeight = 0.06 * business * 0.9;
	const weightTotal = economyWeight + businessWeight + firstWeight;

	const total = base * ((tourism + business) / 2);

	return {
		pairKey,
		distanceKm: distance,
		dailyDemand: {
			economy: Math.round((total * economyWeight) / weightTotal),
			business: Math.round((total * businessWeight) / weightTotal),
			first: Math.max(1, Math.round((total * firstWeight) / weightTotal))
		},
		idealPrice: idealPrices(distance)
	};
};

/**
 * Freight demand for a pair, in tonnes a day, plus the rate the market considers fair
 * per tonne. Deterministic per pair like passenger demand, and driven by the `cargo`
 * modifiers the airport dataset has always carried.
 */
export interface CargoDemand {
	pairKey: string;
	tonnesPerDay: number;
	idealRatePerTonne: number;
}

/** Tonnes a day scale off the tier product, as passengers do, but far more thinly. */
const CARGO_TIER_WEIGHT = 0.55;

/**
 * Fair freight rate per tonne. Calibrated against real air-freight pricing: about
 * 0,63 €/kg over 1.000 km, 2,50 €/kg on a Frankfurt–New York haul and 3,76 €/kg
 * intercontinental, all inside the 2–4 €/kg the long lanes actually fetch. An earlier,
 * cheaper curve left freighters unable to cover their fuel, let alone their crews.
 */
export const idealCargoRate = (distance: number): number =>
	Math.round(180 + 0.9 * distance ** 0.9);

export const routeCargoDemand = (
	fromIata: string,
	toIata: string,
	distance: number
): CargoDemand => {
	const from = getAirport(fromIata);
	const to = getAirport(toIata);
	const pairKey = pairKeyOf(fromIata, toIata);
	const rng = seededRng('cargo-demand', pairKey);

	const cargo = (from.demandModifiers.cargo + to.demandModifiers.cargo) / 2;

	// Freight cares far less than passengers about a hop being short.
	const reach = Math.min(1.15, 0.55 + distance / 9000);
	const tonnes =
		from.tier * to.tier * CARGO_TIER_WEIGHT * cargo * reach * (0.75 + rng() * 0.6);

	return {
		pairKey,
		tonnesPerDay: Math.max(1, Math.round(tonnes)),
		idealRatePerTonne: idealCargoRate(distance)
	};
};

export interface CargoLoadInputs {
	demand: CargoDemand;
	ratePerTonne: number;
	/** The freighter's hold, in tonnes. */
	capacityTonnes: number;
	flightsPerDay: number;
	competitors: { tonnesPerDay: number; ratePerTonne: number }[];
}

/** Tonnes loaded onto one departure, using the same share and elasticity as passengers. */
export const cargoForFlight = ({
	demand,
	ratePerTonne,
	capacityTonnes,
	flightsPerDay,
	competitors
}: CargoLoadInputs): number => {
	if (capacityTonnes <= 0) return 0;

	const flights = Math.max(1, flightsPerDay);
	const ideal = demand.idealRatePerTonne;
	const share = demandShare(
		{ seatsPerDay: capacityTonnes * flights, price: ratePerTonne },
		competitors.map((rival) => ({
			seatsPerDay: rival.tonnesPerDay,
			price: rival.ratePerTonne
		})),
		ideal
	);

	const wanted =
		((demand.tonnesPerDay * share) / flights) * loadFactorForPrice(ratePerTonne, ideal);

	return Math.max(0, Math.min(capacityTonnes, Math.round(wanted * 10) / 10));
};

/** How willing the market is to fill seats at a given price, relative to the fair fare. */
export const loadFactorForPrice = (price: number, ideal: number): number => {
	if (price <= 0) return 1.15;
	const ratio = price / ideal;
	return Math.max(0, Math.min(1.15, 1 - (ratio - 1) * 1.2));
};

/** A carrier's pull on a route: capacity weighted by how keen its pricing is. */
export const attractiveness = (seatsPerDay: number, price: number, ideal: number): number => {
	if (seatsPerDay <= 0) return 0;
	const priceScore = Math.max(0.05, Math.min(1.6, 2 - price / ideal));
	return seatsPerDay * priceScore;
};

/**
 * Share of a route's daily demand a carrier wins, given every carrier serving the pair.
 * With no competition the share is 1.
 */
export const demandShare = (
	mine: { seatsPerDay: number; price: number },
	competitors: { seatsPerDay: number; price: number }[],
	ideal: number
): number => {
	const myPull = attractiveness(mine.seatsPerDay, mine.price, ideal);
	if (myPull <= 0) return 0;

	const rivalPull = competitors.reduce(
		(sum, rival) => sum + attractiveness(rival.seatsPerDay, rival.price, ideal),
		0
	);

	if (rivalPull <= 0) return 1;
	return myPull / (myPull + rivalPull);
};

export interface PaxInputs {
	demand: RouteDemand;
	prices: ClassAmounts;
	seats: ClassAmounts;
	/** Flights this carrier operates on the pair per day, used to split daily demand. */
	flightsPerDay: number;
	competitors: Competitor[];
}

/** Passengers boarding one departure, per class. */
export const passengersForFlight = ({
	demand,
	prices,
	seats,
	flightsPerDay,
	competitors
}: PaxInputs): ClassAmounts => {
	const result: ClassAmounts = { economy: 0, business: 0, first: 0 };
	const flights = Math.max(1, flightsPerDay);

	for (const passengerClass of ['economy', 'business', 'first'] as const) {
		const seatsAvailable = seats[passengerClass];
		if (seatsAvailable <= 0) continue;

		const ideal = demand.idealPrice[passengerClass];
		const price = prices[passengerClass];

		const share = demandShare(
			{ seatsPerDay: seatsAvailable * flights, price },
			competitors.map((rival) => ({
				seatsPerDay: rival.seatsPerDay[passengerClass],
				price: rival.prices[passengerClass]
			})),
			ideal
		);

		const wanted =
			((demand.dailyDemand[passengerClass] * share) / flights) * loadFactorForPrice(price, ideal);

		result[passengerClass] = Math.max(0, Math.min(seatsAvailable, Math.round(wanted)));
	}

	return result;
};

/** Fuzzed figures shown when a route has not been audited: a range, never the exact number. */
export interface VagueRange {
	low: number;
	high: number;
	label: string;
}

const DEMAND_LABELS: [number, string][] = [
	[40, 'very low'],
	[120, 'low'],
	[280, 'medium'],
	[600, 'high'],
	[Number.POSITIVE_INFINITY, 'very high']
];

export const vagueRange = (exact: number, pairKey: string, salt: string): VagueRange => {
	const rng = seededRng('vague', pairKey, salt);
	const skew = 0.85 + rng() * 0.3;
	const centre = exact * skew;

	return {
		low: Math.max(0, Math.floor((centre * 0.65) / 5) * 5),
		high: Math.ceil((centre * 1.35) / 5) * 5,
		label: DEMAND_LABELS.find(([threshold]) => exact < threshold)?.[1] ?? 'unknown'
	};
};
