import { blockHoursExact, getModel, totalSeats } from '$data/aircraft';
import { GATE_RATINGS, gateBlueprint } from '$data/gates';
import type { ClassAmounts } from '$data/types';
import {
	db,
	pairKeyOf,
	type Aircraft,
	type Flight,
	type Route,
	type ScheduleEntry
} from '$db/schema';
import { postTransaction } from '$db/repo';
import { HOUR_MS, dayOfWeekOf, gameNow, timeAt } from './clock';
import { airportTaxFor, fuelCostFor, maintenanceCost, ticketRevenue } from './economy';
import {
	cargoForFlight,
	passengersForFlight,
	routeCargoDemand,
	routeDemand,
	type Competitor
} from './demand';
import { accidentProbability, incidentBaseAmount } from './maintenance';
import { seededRng } from './rng';

export interface FlightContext {
	routes: Map<number, Route>;
	/** Every route in the world grouped by airport pair, for live competition checks. */
	routesByPair: Map<string, Route[]>;
	aircraftByRoute: Map<number, Aircraft[]>;
	seatsByRoute: Map<number, ClassAmounts>;
	/** Hold space each route offers per departure, in tonnes. */
	tonnesByRoute: Map<number, number>;
	fuelPricePerLitre: number;
}

const emptyClassAmounts = (): ClassAmounts => ({ economy: 0, business: 0, first: 0 });

/** Seats a company offers per day on a route, summed over its scheduled departures. */
export const buildFlightContext = async (fuelPricePerLitre: number): Promise<FlightContext> => {
	const [routes, entries, fleet] = await Promise.all([
		db.routes.toArray(),
		db.schedule_entries.toArray(),
		db.aircraft.toArray()
	]);

	const fleetById = new Map(fleet.map((aircraft) => [aircraft.id!, aircraft]));
	const routesById = new Map(routes.map((route) => [route.id!, route]));
	const routesByPair = new Map<string, Route[]>();

	for (const route of routes) {
		const key = pairKeyOf(route.fromIata, route.toIata);
		const existing = routesByPair.get(key);
		if (existing) existing.push(route);
		else routesByPair.set(key, [route]);
	}

	const seatsByRoute = new Map<number, ClassAmounts>();
	const tonnesByRoute = new Map<number, number>();
	const aircraftByRoute = new Map<number, Aircraft[]>();

	for (const entry of entries) {
		const aircraft = fleetById.get(entry.aircraftId);
		if (!aircraft) continue;

		const model = getModel(aircraft.modelId);
		if (model.kind === 'cargo') {
			tonnesByRoute.set(entry.routeId, (tonnesByRoute.get(entry.routeId) ?? 0) + model.payload);
		}

		const seats = seatsByRoute.get(entry.routeId) ?? emptyClassAmounts();
		seats.economy += aircraft.seats.economy;
		seats.business += aircraft.seats.business;
		seats.first += aircraft.seats.first;
		seatsByRoute.set(entry.routeId, seats);

		const list = aircraftByRoute.get(entry.routeId);
		if (list) list.push(aircraft);
		else aircraftByRoute.set(entry.routeId, [aircraft]);
	}

	return {
		routes: routesById,
		routesByPair,
		aircraftByRoute,
		seatsByRoute,
		tonnesByRoute,
		fuelPricePerLitre
	};
};

/** Rival carriers on the same pair, with the capacity and fares they offer today. */
export interface RivalService extends Competitor {
	tonnesPerDay: number;
	cargoRatePerTonne: number;
}

export const competitorsFor = (
	context: FlightContext,
	route: Route,
	weeklyDeparturesByRoute: Map<number, number>
): RivalService[] => {
	const pairKey = pairKeyOf(route.fromIata, route.toIata);
	const rivals = context.routesByPair.get(pairKey) ?? [];

	return rivals
		.filter((rival) => rival.companyId !== route.companyId)
		.map((rival) => {
			const seats = context.seatsByRoute.get(rival.id!) ?? emptyClassAmounts();
			const departures = Math.max(1, (weeklyDeparturesByRoute.get(rival.id!) ?? 7) / 7);
			return {
				companyId: rival.companyId,
				companyName: '',
				seatsPerDay: {
					economy: Math.round(seats.economy * departures),
					business: Math.round(seats.business * departures),
					first: Math.round(seats.first * departures)
				},
				prices: rival.prices,
				tonnesPerDay: Math.round((context.tonnesByRoute.get(rival.id!) ?? 0) * departures),
				cargoRatePerTonne: rival.cargoRatePerTonne
			} satisfies RivalService;
		})
		.filter(
			(rival) =>
				rival.seatsPerDay.economy +
					rival.seatsPerDay.business +
					rival.seatsPerDay.first +
					rival.tonnesPerDay >
				0
		);
};

export interface ExecutedFlight {
	flight: Flight;
	accident: boolean;
	incidentBaseAmount: number;
}

export interface ExecuteFlightInput {
	entry: ScheduleEntry;
	aircraft: Aircraft;
	route: Route;
	departAt: number;
	context: FlightContext;
	dailyDeparturesForRoute: number;
	weeklyDeparturesByRoute: Map<number, number>;
}

/**
 * Runs one scheduled departure: fills the cabin against live competition, bills
 * fuel and the departure airport, banks the fares, and rolls for an accident when
 * the airframe is overdue for maintenance.
 */
export const executeFlight = async ({
	entry,
	aircraft,
	route,
	departAt,
	context,
	dailyDeparturesForRoute,
	weeklyDeparturesByRoute
}: ExecuteFlightInput): Promise<ExecutedFlight> => {
	const model = getModel(aircraft.modelId);
	const arriveAt = departAt + blockHoursExact(model, route.distanceKm) * HOUR_MS;

	// A route is a link between two gates, flown in whichever direction the
	// aircraft currently sits, so a scheduled leg is the outbound or the return.
	const outbound = aircraft.currentIata === route.fromIata;
	const departIata = outbound ? route.fromIata : route.toIata;
	const arriveIata = outbound ? route.toIata : route.fromIata;

	// A freighter sells hold space, a passenger aircraft sells seats. Both draw on the
	// same route, but on demand pools that are counted and priced separately.
	const carriesFreight = model.kind === 'cargo';
	const rivals = competitorsFor(context, route, weeklyDeparturesByRoute);

	let pax: ClassAmounts = { economy: 0, business: 0, first: 0 };
	let cargoTonnes = 0;
	let revenue = 0;

	if (carriesFreight) {
		cargoTonnes = cargoForFlight({
			demand: routeCargoDemand(route.fromIata, route.toIata, route.distanceKm),
			ratePerTonne: route.cargoRatePerTonne,
			capacityTonnes: model.payload,
			flightsPerDay: dailyDeparturesForRoute,
			competitors: rivals.map((rival) => ({
				tonnesPerDay: rival.tonnesPerDay,
				ratePerTonne: rival.cargoRatePerTonne
			}))
		});
		revenue = Math.round(cargoTonnes * route.cargoRatePerTonne);
	} else {
		pax = passengersForFlight({
			demand: routeDemand(route.fromIata, route.toIata, route.distanceKm),
			prices: route.prices,
			seats: aircraft.seats,
			flightsPerDay: dailyDeparturesForRoute,
			competitors: rivals
		});
		revenue = ticketRevenue(pax, route.prices);
	}

	const passengers = pax.economy + pax.business + pax.first;
	const fuelCost = fuelCostFor(model, route.distanceKm, context.fuelPricePerLitre);
	// Charged for the stand actually pushed back from, which flips with the direction.
	// A stand the dataset no longer describes pays the published fees in full.
	const departGate = gateBlueprint(outbound ? route.fromGateId : route.toGateId);
	const taxCost = airportTaxFor(
		departIata,
		model,
		passengers,
		departGate?.maxCategory ?? GATE_RATINGS[GATE_RATINGS.length - 1]
	);

	const rng = seededRng('flight', entry.id ?? 0, departAt);
	const crashed = rng() < accidentProbability(aircraft);

	const flightId = await db.flights.add({
		companyId: route.companyId,
		aircraftId: aircraft.id!,
		routeId: route.id!,
		scheduleEntryId: entry.id!,
		fromIata: departIata,
		toIata: arriveIata,
		distanceKm: route.distanceKm,
		departAt,
		arriveAt,
		pax,
		cargoTonnes,
		revenue: crashed ? 0 : revenue,
		fuelCost,
		taxCost,
		status: crashed ? 'accident' : 'completed'
	});

	await postTransaction(
		route.companyId,
		'fuel',
		-fuelCost,
		`Fuel ${departIata}→${arriveIata} (${aircraft.registration})`,
		{ at: departAt, refId: `flight:${flightId}`, allowOverdraft: true }
	);
	await postTransaction(
		route.companyId,
		'airport_tax',
		-taxCost,
		`${departIata} departure charges (${aircraft.registration})`,
		{ at: departAt, refId: `flight:${flightId}`, allowOverdraft: true }
	);

	if (!crashed && revenue > 0) {
		await postTransaction(
			route.companyId,
			carriesFreight ? 'freight_sales' : 'ticket_sales',
			revenue,
			carriesFreight
				? `${cargoTonnes} t freight ${departIata}→${arriveIata} (${aircraft.registration})`
				: `${passengers} pax ${departIata}→${arriveIata} (${aircraft.registration})`,
			{ at: arriveAt, refId: `flight:${flightId}` }
		);
	}

	const totalKm = aircraft.totalKm + route.distanceKm;
	const kmSinceMaintenance = aircraft.kmSinceMaintenance + route.distanceKm;

	if (crashed) {
		await db.aircraft.update(aircraft.id!, {
			status: 'grounded',
			totalKm,
			kmSinceMaintenance,
			currentIata: arriveIata
		});
	} else {
		// A leg that has not landed yet leaves the aircraft airborne, which is what
		// puts a moving marker on the dashboard map.
		const stillAirborne = arriveAt > gameNow();
		await db.aircraft.update(aircraft.id!, {
			totalKm,
			kmSinceMaintenance,
			currentIata: arriveIata,
			status: stillAirborne ? 'flying' : 'idle'
		});
		if (stillAirborne) await db.flights.update(flightId, { status: 'flying' });
	}

	const flight = await db.flights.get(flightId);

	return {
		flight: flight!,
		accident: crashed,
		incidentBaseAmount: crashed ? incidentBaseAmount(passengers, rng()) : 0
	};
};

/** Sends an aircraft into a heavy check and bills it. */
export const startMaintenance = async (aircraft: Aircraft, at: number): Promise<void> => {
	const model = getModel(aircraft.modelId);
	const cost = maintenanceCost(aircraft.modelId);

	await postTransaction(
		aircraft.companyId,
		'maintenance',
		-cost,
		`Heavy check ${model.name} (${aircraft.registration})`,
		{ at, refId: `aircraft:${aircraft.id}`, allowOverdraft: true }
	);

	await db.aircraft.update(aircraft.id!, {
		status: 'maintenance',
		maintenanceUntil: at + model.maintenanceHours * HOUR_MS
	});
};

/** Timestamps at which a schedule entry fires inside a window (exclusive of `from`). */
export const occurrencesBetween = (
	entry: Pick<ScheduleEntry, 'dayOfWeek' | 'startHour'>,
	fromExclusive: number,
	toInclusive: number
): number[] => {
	const results: number[] = [];
	const firstDay = Math.floor(fromExclusive / 86_400_000);
	const lastDay = Math.floor(toInclusive / 86_400_000);

	for (let dayIndex = firstDay; dayIndex <= lastDay; dayIndex += 1) {
		if (dayOfWeekOf(dayIndex) !== entry.dayOfWeek) continue;
		const at = timeAt(dayIndex, entry.startHour);
		if (at > fromExclusive && at <= toInclusive) results.push(at);
	}

	return results;
};

