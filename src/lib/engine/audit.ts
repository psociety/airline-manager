import type { ClassAmounts } from '$data/types';
import { hasAudit } from '$db/repo';
import { db, pairKeyOf, type Company } from '$db/schema';
import {
	routeCargoDemand,
	routeDemand,
	vagueRange,
	type CargoDemand,
	type RouteDemand,
	type VagueRange
} from './demand';
import { AUDIT_COST_MAX, AUDIT_COST_MIN } from './economy';
import { seededRng } from './rng';

export interface CompetitorView {
	companyId: number;
	companyName: string;
	icao: string;
	prices: ClassAmounts;
	seatsPerDay: ClassAmounts;
	weeklyDepartures: number;
}

export interface RouteIntel {
	pairKey: string;
	audited: boolean;
	auditCost: number;
	demand: RouteDemand;
	/** Freight the pair wants each day, and the rate the market considers fair. */
	cargo: CargoDemand;
	cargoRange: VagueRange;
	/** Only meaningful when `audited` is false: fuzzed ranges instead of exact figures. */
	vague: {
		demand: Record<keyof ClassAmounts, VagueRange>;
		idealPrice: Record<keyof ClassAmounts, VagueRange>;
	};
	competitors: CompetitorView[];
}

/**
 * The quoted audit fee. Random within the spec's 30k–1M band but seeded per
 * company and pair, so the price does not shuffle every time the screen redraws.
 */
export const auditCost = (companyId: number, pairKey: string): number => {
	const rng = seededRng('audit-cost', companyId, pairKey);
	return Math.round((AUDIT_COST_MIN + rng() * (AUDIT_COST_MAX - AUDIT_COST_MIN)) / 1_000) * 1_000;
};

/**
 * The fares to open a route with, and to measure pricing against. An audited route
 * uses the real ideal fare; an unaudited one only ever sees the fuzzed midpoint, so
 * the exact figure cannot be inferred without paying for the survey.
 */
export const workingFares = (intel: RouteIntel): ClassAmounts => {
	if (intel.audited) return { ...intel.demand.idealPrice };

	const midpoint = (range: VagueRange): number => Math.round((range.low + range.high) / 2);
	return {
		economy: midpoint(intel.vague.idealPrice.economy),
		business: midpoint(intel.vague.idealPrice.business),
		first: midpoint(intel.vague.idealPrice.first)
	};
};

/** Airlines already flying a pair, with the capacity and fares they put on it. */
export const competitorsOnPair = async (
	pairKey: string,
	excludeCompanyId: number
): Promise<CompetitorView[]> => {
	const [routes, companies, entries, fleet] = await Promise.all([
		db.routes.toArray(),
		db.companies.toArray(),
		db.schedule_entries.toArray(),
		db.aircraft.toArray()
	]);

	const companiesById = new Map<number, Company>(companies.map((company) => [company.id, company]));
	const fleetById = new Map(fleet.map((aircraft) => [aircraft.id, aircraft]));
	const rivals = routes.filter(
		(route) =>
			pairKeyOf(route.fromIata, route.toIata) === pairKey && route.companyId !== excludeCompanyId
	);

	return rivals
		.map((route) => {
			const company = companiesById.get(route.companyId);
			const routeEntries = entries.filter((entry) => entry.routeId === route.id);
			const seatsPerWeek: ClassAmounts = { economy: 0, business: 0, first: 0 };

			for (const entry of routeEntries) {
				const aircraft = fleetById.get(entry.aircraftId);
				if (!aircraft) continue;
				seatsPerWeek.economy += aircraft.seats.economy;
				seatsPerWeek.business += aircraft.seats.business;
				seatsPerWeek.first += aircraft.seats.first;
			}

			return {
				companyId: route.companyId,
				companyName: company?.name ?? 'Unknown airline',
				icao: company?.icao ?? '???',
				prices: route.prices,
				seatsPerDay: {
					economy: Math.round(seatsPerWeek.economy / 7),
					business: Math.round(seatsPerWeek.business / 7),
					first: Math.round(seatsPerWeek.first / 7)
				},
				weeklyDepartures: routeEntries.length
			} satisfies CompetitorView;
		})
		.sort((left, right) => right.weeklyDepartures - left.weeklyDepartures);
};

/**
 * Everything a player may see about a pair. Demand itself is fixed for the pair
 * forever; only the competition is read live, and only a paid audit reveals the
 * exact numbers.
 */
export const routeIntel = async (
	companyId: number,
	fromIata: string,
	toIata: string,
	distanceKm: number
): Promise<RouteIntel> => {
	const pairKey = pairKeyOf(fromIata, toIata);
	const demand = routeDemand(fromIata, toIata, distanceKm);
	const cargo = routeCargoDemand(fromIata, toIata, distanceKm);
	const audited = await hasAudit(companyId, pairKey);

	return {
		pairKey,
		audited,
		auditCost: auditCost(companyId, pairKey),
		demand,
		cargo,
		cargoRange: vagueRange(cargo.tonnesPerDay, pairKey, 'cargo'),
		vague: {
			demand: {
				economy: vagueRange(demand.dailyDemand.economy, pairKey, 'demand-economy'),
				business: vagueRange(demand.dailyDemand.business, pairKey, 'demand-business'),
				first: vagueRange(demand.dailyDemand.first, pairKey, 'demand-first')
			},
			idealPrice: {
				economy: vagueRange(demand.idealPrice.economy, pairKey, 'price-economy'),
				business: vagueRange(demand.idealPrice.business, pairKey, 'price-business'),
				first: vagueRange(demand.idealPrice.first, pairKey, 'price-first')
			}
		},
		competitors: await competitorsOnPair(pairKey, companyId)
	};
};
