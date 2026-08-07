import { isCargo } from './aircraft';
import type { AircraftModel } from './types';

export const AIRCRAFT_SPRITE_SHEET = '/icons/airplanes.png';

/** The sheet is a 3×3 grid of 100×100 top-down icons, all pointing north. */
export const SPRITE_CELL = 100;
export const SPRITE_COLUMNS = 3;

/** Index into the spritesheet, read left to right, top to bottom. */
export const AircraftSprite = {
	Helicopter: 0,
	GroundVehicle: 1,
	Glider: 2,
	SinglePropeller: 3,
	TwinPropeller: 4,
	FourEngine: 5,
	PrivateJet: 6,
	TwinEngine: 7,
	BigFourEngine: 8
} as const;

export type AircraftSpriteIndex = (typeof AircraftSprite)[keyof typeof AircraftSprite];

/**
 * Everything with propellers. The dataset has no engine data, so the split is
 * curated by type; a test cross-checks it against cruise speed, since no propeller
 * airliner in the set cruises above 720 km/h and no jet below it.
 */
export const FOUR_PROPELLER_MODELS = new Set([
	'L-100', // C-130 Hercules
	'L-188C', // Lockheed Electra
	'L-1049G' // Constellation
]);

export const TWIN_PROPELLER_MODELS = new Set([
	// Freighters
	'S-340BF',
	'EMB-120FC',
	'42-500F',
	'72-500F',
	'Q400-PF',
	// Passenger types
	'DHC-6 Series 100',
	'DC-3',
	'CN-235',
	'S-340B',
	'Il-114',
	'72-500',
	'72-600',
	'F50',
	'Q-200',
	'Q-300',
	'Q-400',
	'42-500',
	'42-600',
	'Jetstream-41',
	'EMB-120',
	'D328-100',
	'S-2000'
]);

/**
 * Four-engine jets. The BAe 146 family really has four, so RJ-85 and the RJ-100QT
 * freighter both belong here, as do the Antonov An-124 and the DC-8 conversions.
 */
export const FOUR_ENGINE_JET_MODELS = new Set([
	// Freighters
	'RJ-100QT',
	'DC8-55CF',
	'DC8-73AF',
	'An-124-100',
	'An-124-100 V2',
	'747-200F',
	'B747-400ERF',
	'747-8F',
	// Passenger types
	'Concorde',
	'DC8-55',
	'DC8-73',
	'707-320C',
	'RJ-85',
	'Il-86',
	'Il-96-300',
	'Il-96M',
	'A340-200',
	'A340-300',
	'A340-500',
	'A340-600',
	'747SP',
	'747-100B',
	'747-200B',
	'747-300',
	'747-400',
	'747-8I',
	'A380-800'
]);

export const BUSINESS_JET_MODELS = new Set(['G650', 'F900-B']);

/**
 * Where a four-engine jet earns the larger of the two four-engine icons. The thresholds
 * are per kind because the icon is about silhouette, not throughput: 300 seats means a
 * widebody, whereas eighty tonnes of freight is what separates the 747s and An-124 from
 * narrow-bodied conversions like the DC-8 freighters.
 */
const BIG_FOUR_ENGINE_SEATS = 300;
const BIG_FOUR_ENGINE_TONNES = 80;

/**
 * The icon that best matches a type's silhouette from above.
 *
 * Tri-jets (727, Tu-154M, DC-10, MD-11, L-1011) and rear-engine twins (CRJ, ERJ-145,
 * MD-83, F-100, 717) both fall through to the two-engine icon: from directly above a
 * tri-jet reads as a two-engine wing, and reserving the private-jet icon for actual
 * business jets keeps a 167-seat MD-83 from looking like a Learjet.
 */
export const spriteForModel = (
	model: Pick<AircraftModel, 'name' | 'seats' | 'payload'>
): AircraftSpriteIndex => {
	if (BUSINESS_JET_MODELS.has(model.name)) return AircraftSprite.PrivateJet;
	if (FOUR_PROPELLER_MODELS.has(model.name)) return AircraftSprite.FourEngine;
	if (TWIN_PROPELLER_MODELS.has(model.name)) return AircraftSprite.TwinPropeller;

	if (FOUR_ENGINE_JET_MODELS.has(model.name)) {
		const isBig = isCargo(model)
			? model.payload >= BIG_FOUR_ENGINE_TONNES
			: model.seats >= BIG_FOUR_ENGINE_SEATS;

		return isBig ? AircraftSprite.BigFourEngine : AircraftSprite.FourEngine;
	}

	return AircraftSprite.TwinEngine;
};

/** CSS background offsets that bring one cell into a `size`-pixel box. */
export const spriteOffset = (index: number, size: number): { x: number; y: number } => ({
	x: -(index % SPRITE_COLUMNS) * size,
	y: -Math.floor(index / SPRITE_COLUMNS) * size
});

/** Background size that scales the whole sheet so one cell fills a `size` box. */
export const spriteSheetSize = (size: number): number => size * SPRITE_COLUMNS;
