export type PassengerClass = 'economy' | 'business' | 'first';

export interface SeatConfig {
	economy: number;
	business: number;
	first: number;
}

export interface ClassAmounts {
	economy: number;
	business: number;
	first: number;
}

export interface AircraftModel {
	id: number;
	name: string;
	manufacturer: string;
	category: number;
	speed: number;
	range: number;
	seats: number;
	payload: number;
	consumption: number;
	wear_speed: number;
	introduction_year: number;
	price: number;
	unlocked: boolean;
	image_name: string;
	big_image_url: string;
}

export type AircraftKind = 'passenger' | 'cargo';

export interface AircraftModelDerived extends AircraftModel {
	/** Freighters carry tonnes and have no cabin; passenger types carry people. */
	kind: AircraftKind;
	/**
	 * Capacity expressed in the same unit for both kinds, so crew size and fuel burn
	 * follow one formula: seats for a passenger type, payload converted to
	 * passenger-equivalents for a freighter.
	 */
	capacityUnits: number;
	employees: number;
	maintenanceIntervalKm: number;
	maintenanceHours: number;
	leaseDailyRate: number;
	leaseDeposit: number;
	imageUrl: string;
}

export interface DemandModifiers {
	tourism: number;
	business: number;
	cargo: number;
}

export interface Airport {
	iataCode: string;
	icaoCode: string;
	name: string;
	city: string;
	country: string;
	countryCode: string;
	continent: string;
	latitude: number;
	longitude: number;
	tier: number;
	runwayLength: number;
	isHubPurchasable: boolean;
	hubPrice: number;
	landingFeePerTon: number;
	passengerFee: number;
	timezone: string;
	demandModifiers: DemandModifiers;
}

/**
 * A stand as the dataset describes it. Stands are not stored in the database — they are
 * derived from the airport's gate count, so only ownership needs persisting. `key` is
 * their stable identity, unchanged by airports being added elsewhere in the dataset.
 */
export interface GateBlueprint {
	key: string;
	airportIata: string;
	number: string;
	maxCategory: number;
	price: number;
}
