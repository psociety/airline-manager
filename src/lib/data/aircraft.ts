import aircraftData from './aircraft_data.json';
import cargoAircraftData from './cargo_aircraft_data.json';
import { resolveAircraftImage } from './images';
import type { AircraftKind, AircraftModel, AircraftModelDerived, SeatConfig } from './types';

const RAW_PASSENGER = (aircraftData as { aircraft: AircraftModel[] }).aircraft;
const RAW_CARGO = (cargoAircraftData as { aircraft: AircraftModel[] }).aircraft;

/** Cabin slots consumed by one seat of each class. */
export const SEAT_SLOT_COST = { economy: 1, business: 2, first: 4 } as const;

/** Baseline crew every aircraft needs regardless of size. */
const BASE_EMPLOYEES = 4;
const SEATS_PER_EMPLOYEE = 12;

/**
 * A tonne of freight is treated as eight passengers' worth of capacity — roughly the
 * 125 kg a passenger and their baggage occupy. It lines the two catalogues up well:
 * the 3,7 t EMB-120FC comes out at 30 units, exactly the 30 seats of the EMB-120 it is
 * converted from. Crew size and fuel burn then use one formula for both kinds.
 */
export const PASSENGER_EQUIVALENTS_PER_TONNE = 8;

export const isCargo = (model: Pick<AircraftModel, 'seats'>): boolean => model.seats === 0;

/** Capacity in a unit shared by both kinds: seats, or freight converted to seats. */
export const capacityUnitsFor = (model: Pick<AircraftModel, 'seats' | 'payload'>): number =>
	isCargo(model) ? Math.round(model.payload * PASSENGER_EQUIVALENTS_PER_TONNE) : model.seats;

/** Kilometres between heavy checks, scaled by how fast the type wears. */
const MAINTENANCE_KM_BASE = 150_000;

/** Ground time for a check: bigger, faster-wearing types sit longer. */
const MAINTENANCE_HOURS_BASE = 8;
const MAINTENANCE_HOURS_PER_CATEGORY = 1.5;

/** Daily lease rate as a fraction of list price; deposit is 30 days up front. */
const LEASE_DAILY_FRACTION = 0.0003;
const LEASE_DEPOSIT_DAYS = 30;

/** Turnaround padding added to pure flight time, in hours. */
export const TURNAROUND_HOURS = 0.75;

/**
 * Crew + ground + maintenance headcount for a type.
 * Anchored on the spec's example: DHC-6 Series 100 (20 seats, category 1) => 7.
 * Freighters are sized the same way, through their payload's capacity units.
 */
export const employeesForModel = (
	model: Pick<AircraftModel, 'seats' | 'payload' | 'category'>
): number =>
	BASE_EMPLOYEES + Math.ceil(capacityUnitsFor(model) / SEATS_PER_EMPLOYEE) + model.category;

export const maintenanceIntervalKmForModel = (model: Pick<AircraftModel, 'wear_speed'>): number =>
	Math.round(MAINTENANCE_KM_BASE / model.wear_speed);

export const maintenanceHoursForModel = (
	model: Pick<AircraftModel, 'category' | 'wear_speed'>
): number =>
	Math.round(
		MAINTENANCE_HOURS_BASE + model.category * MAINTENANCE_HOURS_PER_CATEGORY + model.wear_speed
	);

export const leaseDailyRateForModel = (model: Pick<AircraftModel, 'price'>): number =>
	Math.round(model.price * LEASE_DAILY_FRACTION);

const derive = (model: AircraftModel, kind: AircraftKind): AircraftModelDerived => ({
	...model,
	kind,
	capacityUnits: capacityUnitsFor(model),
	employees: employeesForModel(model),
	maintenanceIntervalKm: maintenanceIntervalKmForModel(model),
	maintenanceHours: maintenanceHoursForModel(model),
	leaseDailyRate: leaseDailyRateForModel(model),
	leaseDeposit: leaseDailyRateForModel(model) * LEASE_DEPOSIT_DAYS,
	imageUrl: resolveAircraftImage(model)
});

export const AIRCRAFT_MODELS: AircraftModelDerived[] = [
	...RAW_PASSENGER.map((model) => derive(model, 'passenger')),
	...RAW_CARGO.map((model) => derive(model, 'cargo'))
].sort((left, right) => left.price - right.price);

export const PASSENGER_MODELS: AircraftModelDerived[] = AIRCRAFT_MODELS.filter(
	(model) => model.kind === 'passenger'
);

export const CARGO_MODELS: AircraftModelDerived[] = AIRCRAFT_MODELS.filter(
	(model) => model.kind === 'cargo'
);

const modelsById = new Map<number, AircraftModelDerived>(
	AIRCRAFT_MODELS.map((model) => [model.id, model])
);

export const getModel = (modelId: number): AircraftModelDerived => {
	const model = modelsById.get(modelId);
	if (!model) throw new Error(`Unknown aircraft model: ${modelId}`);
	return model;
};

export const MANUFACTURERS: string[] = [
	...new Set(AIRCRAFT_MODELS.map((model) => model.manufacturer))
].sort();

/**
 * Litres burned over a distance. Dataset consumption is litres per 100 km per seat, so
 * a freighter burns against its payload's capacity units instead — without that it would
 * fly for nothing, its seat count being zero.
 */
export const fuelLitres = (
	model: Pick<AircraftModel, 'consumption' | 'seats' | 'payload'>,
	distanceKm: number
): number => (model.consumption * capacityUnitsFor(model) * distanceKm) / 100;

/** Pure flight hours, no turnaround. */
export const flightHours = (model: Pick<AircraftModel, 'speed'>, distanceKm: number): number =>
	distanceKm / model.speed;

/** Flight time plus turnaround, the value shown to the player. */
export const blockHoursExact = (model: Pick<AircraftModel, 'speed'>, distanceKm: number): number =>
	flightHours(model, distanceKm) + TURNAROUND_HOURS;

/** Whole-hour slots a leg occupies on the weekly schedule grid. */
export const blockHoursSlots = (model: Pick<AircraftModel, 'speed'>, distanceKm: number): number =>
	Math.max(1, Math.ceil(blockHoursExact(model, distanceKm)));

/**
 * The heaviest aircraft category a budget can put on the ramp. What an airline can
 * afford to fly is what its stands need to accept — sizing a base beyond this buys
 * apron nobody can fill.
 */
export const categoryWithinBudget = (budget: number): number =>
	AIRCRAFT_MODELS.reduce(
		(heaviest, model) =>
			model.price <= budget && model.category > heaviest ? model.category : heaviest,
		0
	);

export const totalSeats = (seats: SeatConfig): number =>
	seats.economy + seats.business + seats.first;

export const usedSeatSlots = (seats: SeatConfig): number =>
	seats.economy * SEAT_SLOT_COST.economy +
	seats.business * SEAT_SLOT_COST.business +
	seats.first * SEAT_SLOT_COST.first;

/** A cabin fits when it uses no more slots than the airframe has, and seats somebody. */
export const seatConfigFits = (seats: SeatConfig, model: Pick<AircraftModel, 'seats'>): boolean =>
	isCargo(model)
		? totalSeats(seats) === 0
		: usedSeatSlots(seats) <= model.seats && totalSeats(seats) > 0;

/** Sensible default cabin: mostly economy, a small premium cabin on bigger types. */
export const defaultSeatConfig = (model: Pick<AircraftModel, 'seats' | 'category'>): SeatConfig => {
	const slots = model.seats;
	// Freighters have no cabin: their capacity is the hold, not a seat layout.
	if (slots === 0) return { economy: 0, business: 0, first: 0 };
	if (slots < 40) return { economy: slots, business: 0, first: 0 };

	const firstSeats = slots >= 200 ? Math.floor(slots * 0.02) : 0;
	const businessSeats = Math.floor(slots * 0.06);
	const remaining =
		slots - firstSeats * SEAT_SLOT_COST.first - businessSeats * SEAT_SLOT_COST.business;

	return { economy: Math.max(0, remaining), business: businessSeats, first: firstSeats };
};

