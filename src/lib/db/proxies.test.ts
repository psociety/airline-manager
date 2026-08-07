import { beforeEach, describe, expect, it } from 'vitest';
import { freshWorld } from '$engine/testing/world';
import { AIRCRAFT_MODELS, defaultSeatConfig } from '$data/aircraft';
import type { ClassAmounts, SeatConfig } from '$data/types';
import {
	acquireAircraft,
	availableGatesAt,
	companyGates,
	createCompany,
	createRoute,
	reconfigureSeats,
	updateRoutePrices
} from './repo';
import { STARTING_CASH, db } from './schema';

/**
 * Stands in for a Svelte `$state` object: a Proxy around a plain object. IndexedDB
 * cannot structured-clone a proxy, so anything written to the database has to be
 * turned back into a plain object first.
 */
const asStateProxy = <T extends object>(value: T): T =>
	new Proxy(value, {
		get: (target, key, receiver) => Reflect.get(target, key, receiver)
	});

describe('repository writes', () => {
	beforeEach(async () => {
		await freshWorld();
	});

	describe('WHEN reactive state is handed to the database', () => {
		it('should store a proxied seat configuration', async () => {
			const company = await createCompany({ name: 'Proxy Air', icao: 'PXY', homeIata: 'BCN' });
			const [gate] = await companyGates(company.id);
			const model = AIRCRAFT_MODELS.find(
				(candidate) =>
					candidate.category <= gate.maxCategory && candidate.price < STARTING_CASH / 3
			);
			if (!model) throw new Error('no model');

			const seats = asStateProxy<SeatConfig>(defaultSeatConfig(model));

			const aircraft = await acquireAircraft({
				companyId: company.id,
				modelId: model.id,
				name: 'Proxy One',
				seats,
				ownership: 'owned',
				homeGateId: gate.key
			});

			const stored = await db.aircraft.get(aircraft.id);
			expect(stored!.seats).toEqual(defaultSeatConfig(model));
		});

		it('should store a proxied cabin refit', async () => {
			const company = await createCompany({ name: 'Refit Air', icao: 'RFT', homeIata: 'BCN' });
			const [gate] = await companyGates(company.id);
			const model = AIRCRAFT_MODELS.find(
				(candidate) =>
					candidate.category <= gate.maxCategory && candidate.price < STARTING_CASH / 3
			);
			if (!model) throw new Error('no model');

			const aircraft = await acquireAircraft({
				companyId: company.id,
				modelId: model.id,
				name: 'Refit One',
				seats: defaultSeatConfig(model),
				ownership: 'owned',
				homeGateId: gate.key
			});

			await reconfigureSeats(
				aircraft.id,
				asStateProxy<SeatConfig>({ economy: 10, business: 2, first: 1 })
			);

			const stored = await db.aircraft.get(aircraft.id);
			expect(stored!.seats).toEqual({ economy: 10, business: 2, first: 1 });
		});

		it('should store proxied fares on a new route', async () => {
			const company = await createCompany({ name: 'Fare Air', icao: 'FRE', homeIata: 'BCN' });
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');

			const route = await createRoute(
				company.id,
				homeGate.key,
				targetGate.key,
				asStateProxy<ClassAmounts>({ economy: 90, business: 240, first: 460 })
			);

			const stored = await db.routes.get(route.id);
			expect(stored!.prices).toEqual({ economy: 90, business: 240, first: 460 });
		});

		it('should store proxied fares on an existing route', async () => {
			const company = await createCompany({ name: 'Price Air', icao: 'PRC', homeIata: 'BCN' });
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');
			const route = await createRoute(company.id, homeGate.key, targetGate.key, {
				economy: 100,
				business: 250,
				first: 500
			});

			await updateRoutePrices(
				route.id,
				asStateProxy<ClassAmounts>({ economy: 130, business: 300, first: 610 })
			);

			const stored = await db.routes.get(route.id);
			expect(stored!.prices).toEqual({ economy: 130, business: 300, first: 610 });
		});

		it('should not keep a live reference to the caller’s object', async () => {
			const company = await createCompany({ name: 'Copy Air', icao: 'CPY', homeIata: 'BCN' });
			const [homeGate] = await companyGates(company.id);
			const [targetGate] = await availableGatesAt('MAD');

			const prices: ClassAmounts = { economy: 100, business: 250, first: 500 };
			const route = await createRoute(company.id, homeGate.key, targetGate.key, prices);

			prices.economy = 999;

			const stored = await db.routes.get(route.id);
			expect(stored!.prices.economy).toBe(100);
		});
	});
});
