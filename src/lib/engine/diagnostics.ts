import { getModel } from '$data/aircraft';
import { db, type Aircraft } from '$db/schema';
import { DAY_NAMES_LONG, dayOfWeekOf, dayIndexOf, gameNow, timeAt } from './clock';
import { isMaintenanceDue } from './maintenance';

export type LegVerdict =
	| 'will-fly'
	| 'wrong-airport'
	| 'out-of-range'
	| 'route-missing'
	| 'aircraft-unavailable';

export interface LegDiagnosis {
	entryId: number;
	dayOfWeek: number;
	startHour: number;
	label: string;
	verdict: LegVerdict;
	detail: string;
}

export interface AircraftDiagnosis {
	aircraftId: number;
	status: Aircraft['status'];
	currentIata: string;
	legs: LegDiagnosis[];
	flyableCount: number;
	blockedCount: number;
	/** Plain-language reason the aircraft is sitting still, or null when all is well. */
	summary: string | null;
	nextDepartureAt: number | null;
}

/**
 * Walks an aircraft's week the way the simulation does and reports what will and
 * will not fly. This exists because "my schedule is full but the aircraft is idle"
 * is otherwise very hard to see: a leg is silently skipped whenever the aircraft is
 * not standing at one of that route's two ends.
 */
export const diagnoseAircraft = async (aircraftId: number): Promise<AircraftDiagnosis> => {
	const aircraft = await db.aircraft.get(aircraftId);
	if (!aircraft) throw new Error(`Unknown aircraft: ${aircraftId}`);

	const model = getModel(aircraft.modelId);
	const entries = (await db.schedule_entries.where('aircraftId').equals(aircraftId).toArray()).sort(
		(left, right) => left.dayOfWeek - right.dayOfWeek || left.startHour - right.startHour
	);

	const routes = new Map(
		(await db.routes.where('companyId').equals(aircraft.companyId).toArray()).map((route) => [
			route.id,
			route
		])
	);

	const legs: LegDiagnosis[] = [];
	let position = aircraft.currentIata;

	for (const entry of entries) {
		const route = routes.get(entry.routeId);

		if (!route) {
			legs.push({
				entryId: entry.id,
				dayOfWeek: entry.dayOfWeek,
				startHour: entry.startHour,
				label: 'closed route',
				verdict: 'route-missing',
				detail: 'The route this leg refers to has been closed'
			});
			continue;
		}

		const label = `${route.fromIata}/${route.toIata}`;

		if (route.distanceKm > model.range) {
			legs.push({
				entryId: entry.id,
				dayOfWeek: entry.dayOfWeek,
				startHour: entry.startHour,
				label,
				verdict: 'out-of-range',
				detail: `${route.distanceKm.toLocaleString('de-DE')} km is beyond the ${model.range.toLocaleString('de-DE')} km range of a ${model.name}`
			});
			continue;
		}

		if (route.fromIata !== position && route.toIata !== position) {
			legs.push({
				entryId: entry.id,
				dayOfWeek: entry.dayOfWeek,
				startHour: entry.startHour,
				label,
				verdict: 'wrong-airport',
				detail: `The aircraft will be at ${position}, which this route does not touch`
			});
			continue;
		}

		const arrival = route.fromIata === position ? route.toIata : route.fromIata;
		legs.push({
			entryId: entry.id,
			dayOfWeek: entry.dayOfWeek,
			startHour: entry.startHour,
			label: `${position}→${arrival}`,
			verdict: 'will-fly',
			detail: `${DAY_NAMES_LONG[entry.dayOfWeek]} ${String(entry.startHour).padStart(2, '0')}:00`
		});
		position = arrival;
	}

	const flyable = legs.filter((leg) => leg.verdict === 'will-fly');
	const blocked = legs.filter((leg) => leg.verdict !== 'will-fly');

	return {
		aircraftId,
		status: aircraft.status,
		currentIata: aircraft.currentIata,
		legs,
		flyableCount: flyable.length,
		blockedCount: blocked.length,
		summary: summarise(aircraft, legs),
		nextDepartureAt: nextDeparture(flyable)
	};
};

const summarise = (aircraft: Aircraft, legs: LegDiagnosis[]): string | null => {
	if (aircraft.status === 'delivering') return 'Still in delivery — it cannot be scheduled yet.';
	if (aircraft.status === 'maintenance') return 'In the hangar for a check.';
	if (aircraft.status === 'grounded') {
		return 'Grounded after an accident. Settle or fight the claim to release it.';
	}
	if (legs.length === 0) return 'Nothing is scheduled for this aircraft.';

	const flyable = legs.filter((leg) => leg.verdict === 'will-fly');
	if (flyable.length === 0) {
		const wrongAirport = legs.filter((leg) => leg.verdict === 'wrong-airport');
		if (wrongAirport.length === legs.length) {
			return `Every leg starts somewhere else. The aircraft is at ${aircraft.currentIata}, so it needs a route touching ${aircraft.currentIata} before anything can depart.`;
		}
		const outOfRange = legs.filter((leg) => leg.verdict === 'out-of-range');
		if (outOfRange.length === legs.length) return 'Every scheduled route is beyond its range.';
		return 'None of the scheduled legs can be flown as things stand.';
	}

	const blocked = legs.length - flyable.length;
	if (blocked > 0) {
		return `${flyable.length} of ${legs.length} legs will fly; ${blocked} will be skipped.`;
	}

	if (isMaintenanceDue(aircraft)) {
		return 'Flying, but overdue for a check — every departure now risks an accident.';
	}
	return null;
};

/** When the next flyable leg is due, so the player can see it is simply not time yet. */
const nextDeparture = (flyable: LegDiagnosis[]): number | null => {
	if (flyable.length === 0) return null;

	const now = gameNow();
	const today = dayIndexOf(now);

	for (let offset = 0; offset <= 7; offset += 1) {
		const dayIndex = today + offset;
		const dayOfWeek = dayOfWeekOf(dayIndex);

		const candidates = flyable
			.filter((leg) => leg.dayOfWeek === dayOfWeek)
			.map((leg) => timeAt(dayIndex, leg.startHour))
			.filter((at) => at > now)
			.sort((left, right) => left - right);

		if (candidates.length > 0) return candidates[0];
	}

	return null;
};
