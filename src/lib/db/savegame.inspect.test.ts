import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { getModel } from '$data/aircraft';
import { db } from './schema';
import { importSave } from './backup';
import { diagnoseAircraft } from '$engine/diagnostics';
import { DAY_NAMES } from '$engine/clock';

/**
 * Drop a save exported from the game at the repository root as `savegame.json`
 * and this walks every aircraft, reporting why each one is or is not flying.
 * Without the file the whole block is skipped, so it never fails a normal run.
 */
const SAVE_PATH = resolve(process.cwd(), 'savegame.json');
const hasSave = existsSync(SAVE_PATH);

describe.skipIf(!hasSave)('shared savegame', () => {
	it('should report the state of every aircraft', async () => {
		if (db.isOpen()) db.close();
		await db.delete();
		await db.open();
		await importSave(readFileSync(SAVE_PATH, 'utf8'));

		const companies = await db.companies.where('controller').equals('player').toArray();
		console.log(
			'\n=== player airlines ===\n',
			companies.map((company) => ({
				id: company.id,
				icao: company.icao,
				name: company.name,
				slug: company.slug,
				hub: company.homeIata,
				cashMillions: Math.round(company.cash / 1_000_000),
				external: company.external_workers,
				hired: company.hired_workers
			}))
		);

		for (const company of companies) {
			const fleet = await db.aircraft.where('companyId').equals(company.id).toArray();
			const routes = await db.routes.where('companyId').equals(company.id).toArray();

			console.log(`\n=== ${company.icao} routes ===`);
			console.table(
				routes.map((route) => ({
					id: route.id,
					link: `${route.fromIata} <-> ${route.toIata}`,
					km: route.distanceKm,
					economy: route.prices.economy
				}))
			);

			for (const aircraft of fleet) {
				const model = getModel(aircraft.modelId);
				const diagnosis = await diagnoseAircraft(aircraft.id);
				const flights = await db.flights.where('aircraftId').equals(aircraft.id).count();

				console.log(`\n--- ${aircraft.name} (${aircraft.registration}) ${model.name} ---`);
				console.log({
					status: aircraft.status,
					at: aircraft.currentIata,
					rangeKm: model.range,
					kmSinceCheck: Math.round(aircraft.kmSinceMaintenance),
					checkEveryKm: model.maintenanceIntervalKm,
					deliveredAt: new Date(aircraft.deliveryAt).toISOString(),
					legsScheduled: diagnosis.legs.length,
					willFly: diagnosis.flyableCount,
					blocked: diagnosis.blockedCount,
					flightsFlown: flights,
					summary: diagnosis.summary
				});

				if (diagnosis.blockedCount > 0) {
					console.table(
						diagnosis.legs
							.filter((leg) => leg.verdict !== 'will-fly')
							.slice(0, 20)
							.map((leg) => ({
								when: `${DAY_NAMES[leg.dayOfWeek]} ${String(leg.startHour).padStart(2, '0')}:00`,
								leg: leg.label,
								why: leg.verdict,
								detail: leg.detail
							}))
					);
				}
			}
		}

		const state = await db.game_state.get(1);
		console.log('\n=== world ===\n', {
			lastTickAt: new Date(state!.lastTickAt).toISOString(),
			clockOffsetHours: Math.round(state!.clockOffsetMs / 3_600_000),
			fuel: state!.fuelPricePerLitre,
			flights: await db.flights.count(),
			transactions: await db.transaction_records.count()
		});

		expect(companies.length).toBeGreaterThan(0);
	});
});
