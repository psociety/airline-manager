import { getModel } from '$data/aircraft';
import type { Aircraft } from '$db/schema';

/** Cap on the per-flight accident chance, however badly overdue an aircraft is. */
export const MAX_ACCIDENT_PROBABILITY = 0.25;
const ACCIDENT_RATE_PER_INTERVAL = 0.03;

export const overrunKm = (aircraft: Pick<Aircraft, 'modelId' | 'kmSinceMaintenance'>): number => {
	const { maintenanceIntervalKm } = getModel(aircraft.modelId);
	return Math.max(0, aircraft.kmSinceMaintenance - maintenanceIntervalKm);
};

export const isMaintenanceDue = (
	aircraft: Pick<Aircraft, 'modelId' | 'kmSinceMaintenance'>
): boolean => overrunKm(aircraft) > 0;

/** Fraction of the service interval already flown, 0..1+ (used for the wear bar). */
export const maintenanceProgress = (
	aircraft: Pick<Aircraft, 'modelId' | 'kmSinceMaintenance'>
): number => {
	const { maintenanceIntervalKm } = getModel(aircraft.modelId);
	return aircraft.kmSinceMaintenance / maintenanceIntervalKm;
};

/**
 * Chance of an accident on a single flight. Zero while the aircraft is inside its
 * service interval, then climbing the longer maintenance is put off.
 */
export const accidentProbability = (
	aircraft: Pick<Aircraft, 'modelId' | 'kmSinceMaintenance'>
): number => {
	const overrun = overrunKm(aircraft);
	if (overrun <= 0) return 0;

	const { maintenanceIntervalKm } = getModel(aircraft.modelId);
	return Math.min(
		MAX_ACCIDENT_PROBABILITY,
		(overrun / maintenanceIntervalKm) * ACCIDENT_RATE_PER_INTERVAL
	);
};

const INCIDENT_BASE = 1_500_000;
const INCIDENT_PER_PASSENGER = 250_000;

/** Damages claimed after an accident, scaled by how many people were on board. */
export const incidentBaseAmount = (passengers: number, severityRoll: number): number => {
	const severity = 0.5 + severityRoll;
	return Math.round((INCIDENT_BASE + passengers * INCIDENT_PER_PASSENGER) * severity);
};

export interface LawsuitOutcome {
	won: boolean;
	amount: number;
	description: string;
}

/**
 * Fighting a claim is a coin flip. Losing costs the original damages plus an
 * extra 10%–100% on top, per the spec.
 */
export const resolveLawsuit = (
	baseAmount: number,
	winRoll: number,
	penaltyRoll: number
): LawsuitOutcome => {
	if (winRoll < 0.5) {
		return { won: true, amount: 0, description: 'Court ruled in the airline’s favour' };
	}

	const penalty = 0.1 + penaltyRoll * 0.9;
	const amount = Math.round(baseAmount * (1 + penalty));

	return {
		won: false,
		amount,
		description: `Lawsuit lost — damages plus ${Math.round(penalty * 100)}% penalty`
	};
};
