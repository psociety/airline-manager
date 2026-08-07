import { fuelLitres, getModel } from '$data/aircraft';
import { getAirport } from '$data/airports';
import { gateFeeFactor } from '$data/gates';
import type { AircraftModel, ClassAmounts } from '$data/types';
import {
	EXTERNAL_WORKER_DAILY_COST,
	HIRED_WORKER_DAILY_COST,
	HIRING_FEE,
	TOTAL_SHARES,
	type Aircraft,
	type Company
} from '$db/schema';

export const BASE_FUEL_PRICE_PER_LITRE = 0.85;
export const FUEL_PRICE_MIN = 0.55;
export const FUEL_PRICE_MAX = 1.35;

/** Random cost band for a route audit, per the spec. */
export const AUDIT_COST_MIN = 30_000;
export const AUDIT_COST_MAX = 1_000_000;

export const fuelCostFor = (
	model: Pick<AircraftModel, 'consumption' | 'seats' | 'payload'>,
	distanceKm: number,
	fuelPricePerLitre: number
): number => Math.round(fuelLitres(model, distanceKm) * fuelPricePerLitre);

/**
 * Departure airport charges: landing fee on the airframe plus a per-passenger fee,
 * scaled by the stand the aircraft pushes back from. Only ever charged at the
 * starting gate's airport.
 */
export const airportTaxFor = (
	departureIata: string,
	model: Pick<AircraftModel, 'payload'>,
	passengers: number,
	gateMaxCategory: number
): number => {
	const airport = getAirport(departureIata);
	const scheduled =
		airport.landingFeePerTon * model.payload + airport.passengerFee * passengers;

	return Math.round(scheduled * gateFeeFactor(gateMaxCategory));
};

export const ticketRevenue = (pax: ClassAmounts, prices: ClassAmounts): number =>
	pax.economy * prices.economy + pax.business * prices.business + pax.first * prices.first;

export const dailyWageBill = (company: Pick<Company, 'external_workers' | 'hired_workers'>): number =>
	company.external_workers * EXTERNAL_WORKER_DAILY_COST +
	company.hired_workers * HIRED_WORKER_DAILY_COST;

export const hiringCost = (workers: number): number => workers * HIRING_FEE;

export const dailyLeaseBill = (fleet: Pick<Aircraft, 'ownership' | 'leaseDailyRate'>[]): number =>
	fleet.reduce(
		(sum, aircraft) => (aircraft.ownership === 'leased' ? sum + aircraft.leaseDailyRate : sum),
		0
	);

/**
 * Maintenance invoice for a heavy check, scaled by how big the type is.
 * Calibrated to land near a tenth of the revenue an airframe earns between
 * checks, which is roughly what real carriers spend.
 */
export const maintenanceCost = (modelId: number): number => {
	const model = getModel(modelId);
	return Math.round(model.price * 0.002 + model.seats * 150);
};

/** An owned airframe loses value with age and hours; leased ones are worth nothing to us. */
export const aircraftBookValue = (aircraft: Pick<Aircraft, 'ownership' | 'modelId' | 'totalKm'>): number => {
	if (aircraft.ownership === 'leased') return 0;
	const model = getModel(aircraft.modelId);
	const wear = Math.min(0.6, aircraft.totalKm / 4_000_000);
	return Math.round(model.price * (1 - wear));
};

/** Price the market pays when a company sells an aircraft back. */
export const aircraftResaleValue = (
	aircraft: Pick<Aircraft, 'ownership' | 'modelId' | 'totalKm'>
): number => Math.round(aircraftBookValue(aircraft) * 0.78);

export interface ValuationInputs {
	company: Pick<Company, 'cash'>;
	fleet: Pick<Aircraft, 'ownership' | 'modelId' | 'totalKm'>[];
	gates: { price: number }[];
	routeCount: number;
}

export interface Valuation {
	assets: number;
	bookValue: number;
	sharePrice: number;
}

/** Goodwill credited per live route: a network is worth more than the metal flying it. */
export const ROUTE_GOODWILL = 400_000;

export interface AssetBreakdown {
	cash: number;
	fleetBookValue: number;
	/** What a forced sale would fetch — well under the book figure the share price uses. */
	fleetResaleValue: number;
	ownedAircraft: number;
	leasedAircraft: number;
	gateValue: number;
	routeCount: number;
	routeGoodwill: number;
	/** Identical to `Valuation.assets`: both figures come from this one fold. */
	total: number;
}

/**
 * The lines behind an airline's asset total, for anyone drawing a balance sheet.
 * `valuation` reads `total` from here so a share price and a statement of assets can
 * never drift apart.
 */
export const assetBreakdown = ({
	company,
	fleet,
	gates,
	routeCount
}: ValuationInputs): AssetBreakdown => {
	const fleetBookValue = fleet.reduce((sum, aircraft) => sum + aircraftBookValue(aircraft), 0);
	const fleetResaleValue = fleet.reduce((sum, aircraft) => sum + aircraftResaleValue(aircraft), 0);
	const gateValue = gates.reduce((sum, gate) => sum + gate.price, 0);
	const routeGoodwill = routeCount * ROUTE_GOODWILL;

	return {
		cash: company.cash,
		fleetBookValue,
		fleetResaleValue,
		ownedAircraft: fleet.filter((aircraft) => aircraft.ownership === 'owned').length,
		leasedAircraft: fleet.filter((aircraft) => aircraft.ownership === 'leased').length,
		gateValue,
		routeCount,
		routeGoodwill,
		total: company.cash + fleetBookValue + gateValue + routeGoodwill
	};
};

/**
 * A share never quotes below this, so a worthless or overdrawn airline still has a
 * price. Anything comparing an ask to book value has to know the floor may be binding.
 */
export const MIN_SHARE_PRICE = 100;

export const valuation = (inputs: ValuationInputs, marketMultiplier: number): Valuation => {
	const assets = assetBreakdown(inputs).total;
	const bookValue = assets / TOTAL_SHARES;

	return {
		assets,
		bookValue,
		sharePrice: Math.max(MIN_SHARE_PRICE, Math.round(bookValue * marketMultiplier))
	};
};

/** The band market sentiment is kept inside. */
export const MARKET_MULTIPLIER_MIN = 0.6;
export const MARKET_MULTIPLIER_MAX = 1.8;

/** Nudge a company's market sentiment, keeping it inside a sane band. */
export const driftMarketMultiplier = (current: number, roll: number): number => {
	const drifted = current * (0.96 + roll * 0.09);
	return Math.min(
		MARKET_MULTIPLIER_MAX,
		Math.max(MARKET_MULTIPLIER_MIN, Number(drifted.toFixed(4)))
	);
};

export const driftFuelPrice = (current: number, roll: number): number => {
	const drifted = current * (0.96 + roll * 0.08);
	return Math.min(FUEL_PRICE_MAX, Math.max(FUEL_PRICE_MIN, Number(drifted.toFixed(4))));
};

export const formatMoney = (amount: number): string =>
	`${Math.round(amount).toLocaleString('de-DE')} €`;

export const formatCompactMoney = (amount: number): string => {
	const absolute = Math.abs(amount);
	if (absolute >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2)}B €`;
	if (absolute >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M €`;
	if (absolute >= 1_000) return `${Math.round(amount / 1_000)}k €`;
	return `${Math.round(amount)} €`;
};
