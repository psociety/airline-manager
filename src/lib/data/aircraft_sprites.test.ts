import { describe, expect, it } from 'vitest';
import { AIRCRAFT_MODELS } from './aircraft';
import {
	AIRCRAFT_SPRITE_SHEET,
	AircraftSprite,
	BUSINESS_JET_MODELS,
	FOUR_ENGINE_JET_MODELS,
	FOUR_PROPELLER_MODELS,
	SPRITE_COLUMNS,
	TWIN_PROPELLER_MODELS,
	spriteForModel,
	spriteOffset,
	spriteSheetSize
} from './aircraft_sprites';

const byName = (name: string) => {
	const model = AIRCRAFT_MODELS.find((candidate) => candidate.name === name);
	if (!model) throw new Error(`missing model ${name}`);
	return model;
};

const PROPELLER_SPEED_CEILING = 720;

describe('aircraft sprites', () => {
	describe('WHEN the sheet is addressed', () => {
		it('should point at the file the game ships', () => {
			expect(AIRCRAFT_SPRITE_SHEET).toBe('/icons/airplanes.png');
		});

		it('should treat the sheet as three columns', () => {
			expect(SPRITE_COLUMNS).toBe(3);
		});

		it.each`
			size   | sheet
			${25}  | ${75}
			${50}  | ${150}
			${100} | ${300}
		`('should scale the sheet to $sheet so one cell fills a $size box', ({ size, sheet }) => {
			expect(spriteSheetSize(size)).toBe(sheet);
		});

		it.each`
			index | x       | y
			${0}  | ${-0}   | ${-0}
			${1}  | ${-25}  | ${-0}
			${2}  | ${-50}  | ${-0}
			${3}  | ${-0}   | ${-25}
			${4}  | ${-25}  | ${-25}
			${5}  | ${-50}  | ${-25}
			${6}  | ${-0}   | ${-50}
			${7}  | ${-25}  | ${-50}
			${8}  | ${-50}  | ${-50}
		`('should offset sprite $index to $x, $y at 25 pixels', ({ index, x, y }) => {
			const result = spriteOffset(index, 25);

			expect(result).toEqual({ x, y });
		});

		it.each`
			index | x       | y
			${4}  | ${-50}  | ${-50}
			${7}  | ${-50}  | ${-100}
			${8}  | ${-100} | ${-100}
		`(
			'should offset sprite $index to $x, $y at the 50 pixel size the map uses',
			({ index, x, y }) => {
				const result = spriteOffset(index, 50);

				expect(result).toEqual({ x, y });
			}
		);

		it('should keep every cell inside the scaled sheet', () => {
			const size = 50;

			for (let index = 0; index < 9; index += 1) {
				const { x, y } = spriteOffset(index, size);

				expect(Math.abs(x) + size).toBeLessThanOrEqual(spriteSheetSize(size));
				expect(Math.abs(y) + size).toBeLessThanOrEqual(spriteSheetSize(size));
			}
		});
	});

	describe('WHEN every model in the dataset is classified', () => {
		it('should give each one a sprite that exists on the sheet', () => {
			const invalid = AIRCRAFT_MODELS.filter((model) => {
				const sprite = spriteForModel(model);
				return sprite < 0 || sprite > 8 || !Number.isInteger(sprite);
			});

			expect(invalid).toEqual([]);
		});

		it('should never pick the helicopter, ground vehicle, glider or single prop', () => {
			const unusable = [
				AircraftSprite.Helicopter,
				AircraftSprite.GroundVehicle,
				AircraftSprite.Glider,
				AircraftSprite.SinglePropeller
			];

			const offenders = AIRCRAFT_MODELS.filter((model) =>
				unusable.includes(spriteForModel(model) as (typeof unusable)[number])
			);

			expect(offenders).toEqual([]);
		});

		it.each`
			name              | sprite                          | why
			${'S-340BF'}      | ${AircraftSprite.TwinPropeller}  | ${'twin turboprop freighter'}
			${'Q400-PF'}      | ${AircraftSprite.TwinPropeller}  | ${'twin turboprop freighter'}
			${'RJ-100QT'}     | ${AircraftSprite.FourEngine}     | ${'four-engine regional freighter'}
			${'DC8-73AF'}     | ${AircraftSprite.FourEngine}     | ${'four jets, 51 t'}
			${'An-124-100'}   | ${AircraftSprite.FourEngine}     | ${'four jets, 25 t'}
			${'747-8F'}       | ${AircraftSprite.BigFourEngine}   | ${'four jets, widebody'}
			${'B747-400ERF'}  | ${AircraftSprite.BigFourEngine}   | ${'four jets, widebody'}
			${'777-200F'}     | ${AircraftSprite.TwinEngine}      | ${'underwing twin'}
			${'MD-11CF'}      | ${AircraftSprite.TwinEngine}      | ${'tri-jet'}
			${'737-800BCF'}   | ${AircraftSprite.TwinEngine}      | ${'underwing twin'}
		`('should draw the freighter $name as sprite $sprite ($why)', ({ name, sprite }) => {
			const result = spriteForModel(byName(name));

			expect(result).toBe(sprite);
		});

		it('should split the fleet exactly as reviewed', () => {
			const counts = new Map<number, number>();
			for (const model of AIRCRAFT_MODELS) {
				const sprite = spriteForModel(model);
				counts.set(sprite, (counts.get(sprite) ?? 0) + 1);
			}

			expect(counts.get(AircraftSprite.TwinPropeller)).toBe(22);
			expect(counts.get(AircraftSprite.FourEngine)).toBe(12);
			expect(counts.get(AircraftSprite.PrivateJet)).toBe(2);
			expect(counts.get(AircraftSprite.TwinEngine)).toBe(93);
			expect(counts.get(AircraftSprite.BigFourEngine)).toBe(18);
			expect(AIRCRAFT_MODELS).toHaveLength(147);
		});
	});

	describe('WHEN a known type is classified', () => {
		it.each`
			name                    | sprite                            | why
			${'DHC-6 Series 100'}   | ${AircraftSprite.TwinPropeller}   | ${'twin turboprop'}
			${'Q-400'}              | ${AircraftSprite.TwinPropeller}   | ${'twin turboprop'}
			${'DC-3'}               | ${AircraftSprite.TwinPropeller}   | ${'twin piston'}
			${'L-188C'}             | ${AircraftSprite.FourEngine}      | ${'four turboprops'}
			${'L-100'}              | ${AircraftSprite.FourEngine}      | ${'four turboprops'}
			${'L-1049G'}            | ${AircraftSprite.FourEngine}      | ${'four pistons'}
			${'RJ-85'}              | ${AircraftSprite.FourEngine}      | ${'four jets, regional'}
			${'Concorde'}           | ${AircraftSprite.FourEngine}      | ${'four jets, 128 seats'}
			${'707-320C'}           | ${AircraftSprite.FourEngine}      | ${'four jets, 219 seats'}
			${'DC8-73'}             | ${AircraftSprite.FourEngine}      | ${'four jets, 259 seats'}
			${'G650'}               | ${AircraftSprite.PrivateJet}      | ${'business jet'}
			${'F900-B'}             | ${AircraftSprite.PrivateJet}      | ${'business jet'}
			${'A320-200'}           | ${AircraftSprite.TwinEngine}      | ${'underwing twin'}
			${'787-9'}              | ${AircraftSprite.TwinEngine}      | ${'underwing twin'}
			${'777-300ER'}          | ${AircraftSprite.TwinEngine}      | ${'underwing twin'}
			${'CRJ-900'}            | ${AircraftSprite.TwinEngine}      | ${'rear-engine twin'}
			${'MD-83'}              | ${AircraftSprite.TwinEngine}      | ${'rear-engine twin'}
			${'F-100'}              | ${AircraftSprite.TwinEngine}      | ${'rear-engine twin'}
			${'DC-10-30'}           | ${AircraftSprite.TwinEngine}      | ${'tri-jet'}
			${'MD-11'}              | ${AircraftSprite.TwinEngine}      | ${'tri-jet'}
			${'727-200'}            | ${AircraftSprite.TwinEngine}      | ${'tri-jet'}
			${'Tu-154M'}            | ${AircraftSprite.TwinEngine}      | ${'tri-jet'}
			${'L-1011-500'}         | ${AircraftSprite.TwinEngine}      | ${'tri-jet'}
			${'Il-96-300'}          | ${AircraftSprite.BigFourEngine}   | ${'four jets, 300 seats'}
			${'A340-600'}           | ${AircraftSprite.BigFourEngine}   | ${'four jets, widebody'}
			${'747-400'}            | ${AircraftSprite.BigFourEngine}   | ${'four jets, widebody'}
			${'A380-800'}           | ${AircraftSprite.BigFourEngine}   | ${'four jets, widebody'}
		`('should draw the $name as sprite $sprite ($why)', ({ name, sprite }) => {
			const result = spriteForModel(byName(name));

			expect(result).toBe(sprite);
		});

		it('should size a four-engine passenger jet by its cabin', () => {
			const medium = spriteForModel({ name: 'DC8-73', seats: 259, payload: 0 });
			const large = spriteForModel({ name: 'DC8-73', seats: 300, payload: 0 });

			expect(medium).toBe(AircraftSprite.FourEngine);
			expect(large).toBe(AircraftSprite.BigFourEngine);
		});

		it('should size a four-engine freighter by its payload', () => {
			const medium = spriteForModel({ name: 'DC8-73AF', seats: 0, payload: 50.71 });
			const large = spriteForModel({ name: 'DC8-73AF', seats: 0, payload: 80 });

			expect(medium).toBe(AircraftSprite.FourEngine);
			expect(large).toBe(AircraftSprite.BigFourEngine);
		});
	});

	describe('WHEN the curated tables are checked against the dataset', () => {
		const names = new Set(AIRCRAFT_MODELS.map((model) => model.name));

		it.each`
			table                       | models
			${'twin propeller'}         | ${TWIN_PROPELLER_MODELS}
			${'four propeller'}         | ${FOUR_PROPELLER_MODELS}
			${'four engine jet'}        | ${FOUR_ENGINE_JET_MODELS}
			${'business jet'}           | ${BUSINESS_JET_MODELS}
		`('should not name a type the $table table cannot find', ({ models }) => {
			const missing = [...(models as Set<string>)].filter((name) => !names.has(name));

			expect(missing).toEqual([]);
		});

		it('should not classify the same type twice', () => {
			const all = [
				...TWIN_PROPELLER_MODELS,
				...FOUR_PROPELLER_MODELS,
				...FOUR_ENGINE_JET_MODELS,
				...BUSINESS_JET_MODELS
			];

			expect(new Set(all).size).toBe(all.length);
		});

		it('should agree with cruise speed about which types have propellers', () => {
			const propellers = new Set([...TWIN_PROPELLER_MODELS, ...FOUR_PROPELLER_MODELS]);

			const fastPropellers = AIRCRAFT_MODELS.filter(
				(model) => propellers.has(model.name) && model.speed > PROPELLER_SPEED_CEILING
			);
			const slowJets = AIRCRAFT_MODELS.filter(
				(model) => !propellers.has(model.name) && model.speed < PROPELLER_SPEED_CEILING
			);

			expect(fastPropellers.map((model) => model.name)).toEqual([]);
			expect(slowJets.map((model) => model.name)).toEqual([]);
		});
	});
});
