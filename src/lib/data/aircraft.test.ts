import { describe, expect, it } from 'vitest';
import {
	AIRCRAFT_MODELS,
	CARGO_MODELS,
	PASSENGER_MODELS,
	blockHoursSlots,
	categoryWithinBudget,
	defaultSeatConfig,
	employeesForModel,
	fuelLitres,
	getModel,
	maintenanceHoursForModel,
	maintenanceIntervalKmForModel,
	seatConfigFits,
	totalSeats,
	usedSeatSlots
} from './aircraft';

const findByName = (name: string) => {
	const model = AIRCRAFT_MODELS.find((candidate) => candidate.name === name);
	if (!model) throw new Error(`missing model ${name}`);
	return model;
};

describe('aircraft data', () => {
	describe('WHEN the dataset is derived', () => {
		it('should expose both catalogues', () => {
			expect(PASSENGER_MODELS).toHaveLength(119);
			expect(CARGO_MODELS).toHaveLength(28);
			expect(AIRCRAFT_MODELS).toHaveLength(147);
		});

		it('should mark each model as passenger or freight', () => {
			expect(PASSENGER_MODELS.every((model) => model.kind === 'passenger')).toBe(true);
			expect(CARGO_MODELS.every((model) => model.kind === 'cargo')).toBe(true);
		});

		it('should give a freighter capacity from its hold, not its cabin', () => {
			const freighter = findByName('EMB-120FC');
			const passengerTwin = findByName('EMB-120');

			expect(freighter.seats).toBe(0);
			expect(freighter.payload).toBe(3.7);
			// Eight passenger-equivalents to the tonne lands within a seat of its twin.
			expect(freighter.capacityUnits).toBe(30);
			expect(passengerTwin.seats).toBe(30);
		});

		it('should never leave a freighter with zero capacity', () => {
			const weightless = CARGO_MODELS.filter((model) => model.capacityUnits <= 0);

			expect(weightless).toEqual([]);
		});

		it('should resolve an image for every model', () => {
			const withoutImage = AIRCRAFT_MODELS.filter((model) => !model.imageUrl);

			expect(withoutImage).toEqual([]);
		});

		it('should give every model a positive employee count', () => {
			const invalid = AIRCRAFT_MODELS.filter((model) => model.employees <= 0);

			expect(invalid).toEqual([]);
		});
	});

	describe('WHEN counting the employees a type needs', () => {
		it('should need 7 employees for the DHC-6 Series 100', () => {
			const model = findByName('DHC-6 Series 100');

			const result = employeesForModel(model);

			expect(result).toBe(7);
		});

		it.each`
			seats  | category | expected
			${20}  | ${1}     | ${7}
			${180} | ${5}     | ${24}
			${853} | ${8}     | ${84}
		`(
			'should need $expected employees for $seats seats in category $category',
			({ seats, category, expected }) => {
				const result = employeesForModel({ seats, category, payload: 0 });

				expect(result).toBe(expected);
			}
		);

		it.each`
			payload | category | expected
			${3.7}  | ${2}     | ${9}
			${134}  | ${10}    | ${104}
		`(
			'should crew a $payload tonne freighter in category $category with $expected',
			({ payload, category, expected }) => {
				const result = employeesForModel({ seats: 0, payload, category });

				expect(result).toBe(expected);
			}
		);
	});

	describe('WHEN deriving maintenance requirements', () => {
		it.each`
			wearSpeed | expected
			${1.2}    | ${125000}
			${3.5}    | ${42857}
			${4.5}    | ${33333}
		`('should service every $expected km at wear speed $wearSpeed', ({ wearSpeed, expected }) => {
			const result = maintenanceIntervalKmForModel({ wear_speed: wearSpeed });

			expect(result).toBe(expected);
		});

		it('should keep every check between 9 and 30 hours', () => {
			const durations = AIRCRAFT_MODELS.map((model) =>
				maintenanceHoursForModel({ category: model.category, wear_speed: model.wear_speed })
			);

			expect(Math.min(...durations)).toBeGreaterThanOrEqual(9);
			expect(Math.max(...durations)).toBeLessThanOrEqual(30);
		});
	});

	describe('WHEN computing fuel burn', () => {
		it('should burn about 4300 litres for an A320-200 over 1000 km', () => {
			const model = findByName('A320-200');

			const result = fuelLitres(model, 1000);

			expect(Math.round(result)).toBe(4302);
		});

		it('should burn about 970 litres for a DHC-6 Series 100 over 1000 km', () => {
			const model = findByName('DHC-6 Series 100');

			const result = fuelLitres(model, 1000);

			expect(Math.round(result)).toBe(970);
		});

		it('should burn fuel for a freighter despite it having no seats', () => {
			const result = fuelLitres(findByName('747-8F'), 1000);

			// 134 t at eight units a tonne, 3,21 L/100km per unit.
			expect(Math.round(result)).toBe(34411);
			expect(result).toBeGreaterThan(0);
		});

		it('should burn nothing only when there is genuinely no capacity', () => {
			const dry = AIRCRAFT_MODELS.filter((model) => fuelLitres(model, 1000) <= 0);

			expect(dry).toEqual([]);
		});
	});

	describe('WHEN sizing a leg on the schedule grid', () => {
		it.each`
			speed  | distance | expected
			${800} | ${800}   | ${2}
			${800} | ${2400}  | ${4}
			${297} | ${300}   | ${2}
		`(
			'should take $expected slots at $speed km/h over $distance km',
			({ speed, distance, expected }) => {
				const result = blockHoursSlots({ speed }, distance);

				expect(result).toBe(expected);
			}
		);
	});

	describe('WHEN configuring a cabin', () => {
		it.each`
			economy | business | first | slots
			${100}  | ${0}     | ${0}  | ${100}
			${50}   | ${10}    | ${5}  | ${90}
		`(
			'should use $slots slots for $economy/$business/$first',
			({ economy, business, first, slots }) => {
				const result = usedSeatSlots({ economy, business, first });

				expect(result).toBe(slots);
			}
		);

		it('should reject a cabin that overflows the airframe', () => {
			const result = seatConfigFits({ economy: 100, business: 20, first: 10 }, { seats: 100 });

			expect(result).toBe(false);
		});

		it('should reject an empty cabin on a passenger type', () => {
			const result = seatConfigFits({ economy: 0, business: 0, first: 0 }, { seats: 100 });

			expect(result).toBe(false);
		});

		it('should require a freighter to carry no seats at all', () => {
			expect(seatConfigFits({ economy: 0, business: 0, first: 0 }, { seats: 0 })).toBe(true);
			expect(seatConfigFits({ economy: 10, business: 0, first: 0 }, { seats: 0 })).toBe(false);
		});

		it('should leave a freighter cabin empty by default', () => {
			const result = defaultSeatConfig(findByName('747-8F'));

			expect(totalSeats(result)).toBe(0);
		});

		it('should produce a fitting default cabin for every model', () => {
			const invalid = AIRCRAFT_MODELS.filter(
				(model) => !seatConfigFits(defaultSeatConfig(model), model)
			);

			expect(invalid).toEqual([]);
		});

		it('should seat fewer passengers than the all-economy maximum once premium cabins exist', () => {
			const model = findByName('A320-200');

			const result = totalSeats(defaultSeatConfig(model));

			expect(result).toBeLessThan(model.seats);
			expect(result).toBeGreaterThan(0);
		});
	});

	describe('WHEN looking a model up by id', () => {
		it('should throw for an unknown id', () => {
			expect(() => getModel(-1)).toThrow('Unknown aircraft model');
		});
	});

	describe('WHEN sizing a base to a budget', () => {
		it('should reach no category at all below the cheapest airframe', () => {
			const cheapest = AIRCRAFT_MODELS[0].price;

			const result = categoryWithinBudget(cheapest - 1);

			expect(result).toBe(0);
		});

		it('should reach the heaviest category in the catalogue on an unlimited budget', () => {
			const heaviest = AIRCRAFT_MODELS.reduce(
				(top, model) => Math.max(top, model.category),
				0
			);

			const result = categoryWithinBudget(Number.MAX_SAFE_INTEGER);

			expect(result).toBe(heaviest);
		});

		it('should never shrink as the budget grows', () => {
			const budgets = [5_000_000, 15_000_000, 30_000_000, 80_000_000, 400_000_000];

			const reached = budgets.map(categoryWithinBudget);

			expect(reached).toEqual([...reached].sort((left, right) => left - right));
		});

		it('should name a category the budget can actually buy', () => {
			const budget = 30_000_000;

			const result = categoryWithinBudget(budget);

			expect(
				AIRCRAFT_MODELS.some(
					(model) => model.category === result && model.price <= budget
				)
			).toBe(true);
		});
	});
});
