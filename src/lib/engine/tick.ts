import { getModel } from '$data/aircraft';
import { postTransaction } from '$db/repo';
import { db, isAiRun, type Aircraft, type GameState, type ScheduleEntry } from '$db/schema';
import { runAiDay } from './ai';
import { runBrokerDay } from './broker';
import { runCeoDay } from './ceo';
import { DAY_MS, dayIndexOf, gameNow, startOfDay } from './clock';
import { dailyLeaseBill, dailyWageBill, driftFuelPrice, driftMarketMultiplier } from './economy';
import {
	buildFlightContext,
	executeFlight,
	occurrencesBetween,
	startMaintenance
} from './flights';
import { isMaintenanceDue } from './maintenance';
import { seededRng } from './rng';
import { runBidDay, type BidOutcome } from './takeover';

/** How far back we are willing to simulate when the player has been away. */
export const MAX_CATCHUP_DAYS = 30;

export interface CatchUpSummary {
	from: number;
	to: number;
	daysProcessed: number;
	flightsFlown: number;
	accidents: number;
	deliveries: number;
	maintenanceStarted: number;
	skippedDays: number;
	/** Shares handed to a broker desk as chief executives' fees while the player was away. */
	ceoSharesPaid: number;
	/**
	 * Takeover offers that closed while the player was away. Safe to carry a list rather than a
	 * count: a summary is a return value the away screen reads once, never a stored row.
	 */
	bidOutcomes: BidOutcome[];
}

const emptySummary = (from: number, to: number): CatchUpSummary => ({
	from,
	to,
	daysProcessed: 0,
	flightsFlown: 0,
	accidents: 0,
	deliveries: 0,
	maintenanceStarted: 0,
	skippedDays: 0,
	ceoSharesPaid: 0,
	bidOutcomes: []
});

const completeDeliveries = async (upTo: number): Promise<number> => {
	const arriving = await db.aircraft
		.where('status')
		.equals('delivering')
		.filter((aircraft) => aircraft.deliveryAt <= upTo)
		.toArray();

	for (const aircraft of arriving) {
		await db.aircraft.update(aircraft.id!, { status: 'idle' });
	}
	return arriving.length;
};

const completeMaintenance = async (upTo: number): Promise<void> => {
	const finished = await db.aircraft
		.where('status')
		.equals('maintenance')
		.filter((aircraft) => aircraft.maintenanceUntil !== null && aircraft.maintenanceUntil <= upTo)
		.toArray();

	for (const aircraft of finished) {
		await db.aircraft.update(aircraft.id!, {
			status: 'idle',
			maintenanceUntil: null,
			kmSinceMaintenance: 0
		});
	}
};

const landArrivedFlights = async (upTo: number): Promise<void> => {
	const airborne = await db.flights
		.where('status')
		.equals('flying')
		.filter((flight) => flight.arriveAt <= upTo)
		.toArray();

	for (const flight of airborne) {
		await db.flights.update(flight.id!, { status: 'completed' });
		const aircraft = await db.aircraft.get(flight.aircraftId);
		if (aircraft?.status === 'flying') {
			await db.aircraft.update(aircraft.id!, { status: 'idle' });
		}
	}
};

/** Wages, leases and market drift, charged once per game day. */
const runDailyCharges = async (dayIndex: number): Promise<void> => {
	const companies = await db.companies.toArray();
	const at = startOfDay(dayIndex);

	for (const company of companies) {
		const wages = dailyWageBill(company);
		if (wages > 0) {
			await postTransaction(
				company.id!,
				'wages',
				-wages,
				`Daily wages — ${company.external_workers} external, ${company.hired_workers} hired`,
				{ at, allowOverdraft: true }
			);
		}

		const fleet = await db.aircraft.where('companyId').equals(company.id!).toArray();
		const leases = dailyLeaseBill(fleet);
		if (leases > 0) {
			await postTransaction(company.id!, 'aircraft_lease', -leases, 'Daily lease payments', {
				at,
				allowOverdraft: true
			});
		}

		const rng = seededRng('market', company.id!, dayIndex);
		await db.companies.update(company.id!, {
			marketMultiplier: driftMarketMultiplier(company.marketMultiplier, rng())
		});
	}
};

interface FlightPlanItem {
	entry: ScheduleEntry;
	at: number;
}

/**
 * Replays every scheduled departure between two instants, in chronological order,
 * so aircraft state, maintenance and cash all evolve exactly as they would have live.
 */
const runScheduledFlights = async (
	fromExclusive: number,
	toInclusive: number,
	state: GameState,
	summary: CatchUpSummary
): Promise<void> => {
	const entries = await db.schedule_entries.toArray();
	if (entries.length === 0) return;

	const plan: FlightPlanItem[] = [];
	for (const entry of entries) {
		for (const at of occurrencesBetween(entry, fromExclusive, toInclusive)) {
			plan.push({ entry, at });
		}
	}
	if (plan.length === 0) return;

	plan.sort((left, right) => left.at - right.at);

	const context = await buildFlightContext(state.fuelPricePerLitre);
	const aiRunCompanyIds = new Set(
		(await db.companies.toArray()).filter(isAiRun).map((company) => company.id)
	);
	const weeklyDeparturesByRoute = new Map<number, number>();
	const dailyDeparturesByRoute = new Map<number, number>();

	for (const entry of entries) {
		weeklyDeparturesByRoute.set(
			entry.routeId,
			(weeklyDeparturesByRoute.get(entry.routeId) ?? 0) + 1
		);
	}
	for (const [routeId, weekly] of weeklyDeparturesByRoute) {
		dailyDeparturesByRoute.set(routeId, Math.max(1, weekly / 7));
	}

	for (const item of plan) {
		const aircraft = await db.aircraft.get(item.entry.aircraftId);
		const route = context.routes.get(item.entry.routeId);
		if (!aircraft || !route) continue;

		// Deliveries and checks that completed before this departure free the aircraft up.
		if (aircraft.status === 'delivering' && aircraft.deliveryAt <= item.at) {
			await db.aircraft.update(aircraft.id!, { status: 'idle' });
			aircraft.status = 'idle';
			summary.deliveries += 1;
		}
		if (
			aircraft.status === 'maintenance' &&
			aircraft.maintenanceUntil !== null &&
			aircraft.maintenanceUntil <= item.at
		) {
			await db.aircraft.update(aircraft.id!, {
				status: 'idle',
				maintenanceUntil: null,
				kmSinceMaintenance: 0
			});
			aircraft.status = 'idle';
			aircraft.kmSinceMaintenance = 0;
			aircraft.maintenanceUntil = null;
		}
		if (aircraft.status === 'flying') {
			const airborne = await db.flights
				.where('aircraftId')
				.equals(aircraft.id!)
				.filter((flight) => flight.status === 'flying' && flight.arriveAt <= item.at)
				.toArray();
			for (const flight of airborne) {
				await db.flights.update(flight.id!, { status: 'completed' });
			}
			if (airborne.length > 0) {
				await db.aircraft.update(aircraft.id!, { status: 'idle' });
				aircraft.status = 'idle';
			}
		}

		// Grounded, still in a check, or not yet delivered: the leg simply does not fly.
		if (aircraft.status !== 'idle') continue;

		// An aircraft can only fly a leg if it is sitting at one end of that route.
		if (aircraft.currentIata !== route.fromIata && aircraft.currentIata !== route.toIata) continue;

		const model = getModel(aircraft.modelId);
		if (route.distanceKm > model.range) continue;

		const executed = await executeFlight({
			entry: item.entry,
			aircraft,
			route,
			departAt: item.at,
			context,
			dailyDeparturesForRoute: dailyDeparturesByRoute.get(route.id!) ?? 1,
			weeklyDeparturesByRoute
		});

		summary.flightsFlown += 1;

		if (executed.accident) {
			summary.accidents += 1;
			await db.incidents.add({
				companyId: route.companyId,
				aircraftId: aircraft.id!,
				aircraftName: `${aircraft.name} (${aircraft.registration})`,
				flightId: executed.flight.id!,
				at: item.at,
				passengers:
					executed.flight.pax.economy +
					executed.flight.pax.business +
					executed.flight.pax.first,
				baseAmount: executed.incidentBaseAmount,
				status: 'pending',
				outcome: null,
				finalAmount: null,
				resolvedAt: null
			});
			continue;
		}

		// An AI-run airline services an overdue airframe as soon as it lands, and a hired
		// chief executive does the same. A fleet the player runs themselves is left alone on
		// purpose: deciding when to take an aircraft out of service, and how much accident
		// risk to run in the meantime, is the player's call.
		const updated = await db.aircraft.get(aircraft.id!);
		if (
			updated &&
			updated.status === 'idle' &&
			isMaintenanceDue(updated) &&
			aiRunCompanyIds.has(route.companyId)
		) {
			await startMaintenance(updated, executed.flight.arriveAt);
			summary.maintenanceStarted += 1;
		}
	}
};

/**
 * Advances the world from the last watermark to `now`, day by day. Idempotent:
 * the watermark only ever moves forward, so re-running never double-charges.
 */
export const catchUp = async (now = gameNow()): Promise<CatchUpSummary> => {
	const state = await db.game_state.get(1);
	if (!state) throw new Error('Game state missing — the world has not been seeded');

	const summary = emptySummary(state.lastTickAt, now);
	if (now <= state.lastTickAt) return summary;

	const earliest = now - MAX_CATCHUP_DAYS * DAY_MS;
	let cursor = state.lastTickAt;

	if (cursor < earliest) {
		summary.skippedDays = Math.floor((earliest - cursor) / DAY_MS);
		cursor = earliest;
	}

	let workingState: GameState = { ...state, lastTickAt: cursor };
	const finalDay = dayIndexOf(now);

	while (cursor < now) {
		const currentDay = dayIndexOf(cursor);
		const nextDayStart = startOfDay(currentDay + 1);
		const chunkEnd = Math.min(nextDayStart, now);

		await runScheduledFlights(cursor, chunkEnd, workingState, summary);

		// Crossing midnight closes the books on that day and lets the AI act.
		if (chunkEnd === nextDayStart || currentDay < finalDay) {
			const closingDay = currentDay + 1;
			if (closingDay > workingState.lastProcessedDay) {
				await runDailyCharges(closingDay);

				const rng = seededRng('fuel', workingState.seed, closingDay);
				const fuelPricePerLitre = driftFuelPrice(workingState.fuelPricePerLitre, rng());
				await db.game_state.update(1, { fuelPricePerLitre, lastProcessedDay: closingDay });
				workingState = { ...workingState, fuelPricePerLitre, lastProcessedDay: closingDay };

				await runAiDay(closingDay);

				// After the carriers, so a chief executive is paid for a day they actually ran
				// the airline: paying first could dismiss them and then the AI turn would skip
				// the airline, which is the player paying for nothing.
				summary.ceoSharesPaid += await runCeoDay(closingDay);

				// After the carriers and their fees, so that a board's means to defend itself
				// is the cash it actually ended the day holding, and the register a closing
				// offer is put to is the settled one — a chief executive's fee moves a share
				// and can hand control over on its own.
				summary.bidOutcomes.push(...(await runBidDay(closingDay)));

				// After the fees too, because floating shares is part of the carriers' turn and
				// a desk's buying room is sized at the top of its own: a desk going first would
				// only ever see yesterday's order book.
				await runBrokerDay(closingDay);
				summary.daysProcessed += 1;
			}
		}

		cursor = chunkEnd;
		await db.game_state.update(1, { lastTickAt: cursor });
		workingState = { ...workingState, lastTickAt: cursor };
	}

	summary.deliveries += await completeDeliveries(now);
	await completeMaintenance(now);
	await landArrivedFlights(now);
	await db.game_state.update(1, { lastTickAt: now });

	return summary;
};

export const pendingDeliveries = async (companyId: number): Promise<Aircraft[]> => {
	const fleet = await db.aircraft
		.where('[companyId+status]')
		.equals([companyId, 'delivering'])
		.toArray();
	return fleet.sort((left, right) => left.deliveryAt - right.deliveryAt);
};
