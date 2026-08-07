import Dexie, { type EntityTable } from 'dexie';
import type { ClassAmounts, SeatConfig } from '$data/types';

export const PLAYER_HOLDER_ID = 'p:1';
export const TOTAL_SHARES = 3_000;
export const CONTROL_THRESHOLD = TOTAL_SHARES / 2;
export const STARTING_CASH = 30_000_000;

export const EMPLOYEES_PER_ROUTE = 46;
export const EMPLOYEES_PER_GATE = 10;
export const HIRING_FEE = 275;
export const EXTERNAL_WORKER_DAILY_COST = 330;
export const HIRED_WORKER_DAILY_COST = 294;

export type CompanyController = 'player' | 'ai';
export type AircraftStatus = 'delivering' | 'idle' | 'flying' | 'maintenance' | 'grounded';
export type AircraftOwnership = 'owned' | 'leased';
export type FlightStatus = 'scheduled' | 'flying' | 'completed' | 'cancelled' | 'accident';
export type IncidentStatus = 'pending' | 'settled' | 'litigated';
export type TransactionDirection = 'income' | 'expense';
export type BidStatus = 'open' | 'succeeded' | 'partial' | 'failed' | 'withdrawn';

export type TransactionCategory =
	| 'aircraft_purchase'
	| 'aircraft_lease_deposit'
	| 'aircraft_lease'
	| 'aircraft_sale'
	| 'gate_purchase'
	| 'route_setup'
	| 'route_audit'
	| 'ticket_sales'
	| 'freight_sales'
	| 'fuel'
	| 'airport_tax'
	| 'wages'
	| 'hiring_fee'
	| 'maintenance'
	| 'incident_settlement'
	| 'incident_lawsuit'
	| 'share_purchase'
	| 'share_sale';

export interface GameState {
	id: number;
	createdAt: number;
	lastTickAt: number;
	lastProcessedDay: number;
	fuelPricePerLitre: number;
	seed: number;
	seededAt: number;
	/** Milliseconds the world clock runs ahead of wall time (dev fast-forward). */
	clockOffsetMs: number;
}

export interface Company {
	id: number;
	slug: string;
	name: string;
	icao: string;
	controller: CompanyController;
	cash: number;
	homeIata: string;
	hired_workers: number;
	external_workers: number;
	marketMultiplier: number;
	firstAircraftDelivered: number;
	lastAiDay: number;
	createdAt: number;
	colour: string;
	/**
	 * True while a hired chief executive is running the airline. Deliberately not the
	 * `controller` field: flipping that to 'ai' would drop the airline out of
	 * `playerCompanies` and so out of the player's own switcher, and `refreshControl` — a
	 * pure function of the register with no memory — would flip it straight back the next
	 * time any listing on the airline settled.
	 *
	 * Absent on airlines founded before chief executives existed. Not indexed, so it cannot
	 * be used in a `where()` without a schema version bump.
	 */
	ceoHired?: boolean;
	/** Last day the chief executive has been paid for. Mirrors `lastAiDay`. */
	lastCeoDay?: number;
	/**
	 * Day until which the board has barred a fresh takeover offer, after seeing one off.
	 * Absent on airlines that have never been bid for. Not indexed, so it cannot be used in
	 * a `where()` without a schema version bump.
	 */
	bidLockoutUntilDay?: number;
}

export interface Shareholding {
	id: number;
	companyId: number;
	holderId: string;
	quantity: number;
}

export interface ShareListing {
	id: number;
	companyId: number;
	sellerId: string;
	quantity: number;
	pricePerShare: number;
	createdAt: number;
	/**
	 * Wallet to credit when the sale goes through. An airline selling its own float is
	 * found from its holder id, but the player holds shares personally and banks the
	 * proceeds through one of their airlines, so that airline has to be named here.
	 * Absent on a treasury listing, and on any listing made before this field existed.
	 */
	proceedsCompanyId?: number;
}

export interface ShareTrade {
	id: number;
	companyId: number;
	at: number;
	buyerId: string;
	sellerId: string;
	quantity: number;
	pricePerShare: number;
}

/**
 * A standing offer to buy a block of one airline's shares at a stated price, open for a few
 * days while the target's board reacts to it. Unlike a `ShareListing` — which only reaches
 * shares a holder chose to sell — a bid is put to every name on the register, which is what
 * makes an airline with no float reachable at all.
 */
export interface TakeoverBid {
	id: number;
	targetCompanyId: number;
	/**
	 * Who is bidding, as a polymorphic holder id like everywhere else. Always the player
	 * today; an AI raider later needs no schema change.
	 */
	bidderHolderId: string;
	/**
	 * The wallet the escrow came out of and the refund goes back to. The player holds shares
	 * personally but banks through an airline, exactly as `ShareListing.proceedsCompanyId`.
	 */
	bidderCompanyId: number;
	pricePerShare: number;
	/** Shares wanted on top of whatever the bidder already holds. */
	sharesSought: number;
	/** Cash already out of the wallet. Drawn down per share tendered; the rest is refunded. */
	escrow: number;
	openedAt: number;
	openedDay: number;
	/** Resolution runs on the first day close at or after this day, not only on it exactly. */
	closesDay: number;
	status: BidStatus;
	sharesTendered: number;
	resolvedAt: number | null;
	/** What the board last did about it, as a sentence the screens can print as-is. */
	defence: string | null;
}

/**
 * A market desk with no balance sheet: it trades airline equity but never operates an
 * airline, so it is deliberately not a `companies` row — nothing that enumerates companies
 * for wages, valuations, the market table or the AI day should ever see one. Its
 * temperament is seeded off `key`, so a desk's personality survives being re-created.
 */
export interface Broker {
	id: number;
	key: string;
	name: string;
	/** Last day whose turn this desk has taken. Mirrors `companies.lastAiDay`. */
	lastBrokerDay: number;
	createdAt: number;
}

/**
 * Who owns which stand. Stands themselves are not stored: they are derived from the
 * airport dataset by `gatesForAirport`, so the only thing worth persisting is the small
 * set that somebody has bought. `gateKey` is the primary key, e.g. `ATL-A1`.
 */
export interface GateOwnership {
	gateKey: string;
	airportIata: string;
	companyId: number;
	purchasedAt: number;
}

/** A stand as the interface shows it: the derived blueprint plus who holds it. */
export interface OwnedGate {
	key: string;
	airportIata: string;
	number: string;
	maxCategory: number;
	price: number;
	companyId: number;
	purchasedAt: number;
}

/** Shape of the pre-refactor gates table, read only by the version 2 migration. */
interface LegacyGate {
	id: number;
	airportIata: string;
	number: string;
	maxCategory: number;
	price: number;
	ownerCompanyId: number;
	purchasedAt: number | null;
}

export interface Aircraft {
	id: number;
	companyId: number;
	modelId: number;
	name: string;
	registration: string;
	ownership: AircraftOwnership;
	leaseDailyRate: number;
	seats: SeatConfig;
	status: AircraftStatus;
	orderedAt: number;
	deliveryAt: number;
	homeGateId: string;
	currentIata: string;
	totalKm: number;
	kmSinceMaintenance: number;
	maintenanceUntil: number | null;
	purchasePrice: number;
	createdAt: number;
}

export interface Route {
	id: number;
	companyId: number;
	fromGateId: string;
	toGateId: string;
	fromIata: string;
	toIata: string;
	distanceKm: number;
	prices: ClassAmounts;
	/** What the airline charges per tonne of freight on this link. */
	cargoRatePerTonne: number;
	createdAt: number;
}

export interface RouteAudit {
	id: number;
	companyId: number;
	pairKey: string;
	cost: number;
	purchasedAt: number;
}

export interface ScheduleEntry {
	id: number;
	companyId: number;
	aircraftId: number;
	routeId: number;
	dayOfWeek: number;
	startHour: number;
	blockHours: number;
	createdAt: number;
}

export interface Flight {
	id: number;
	companyId: number;
	aircraftId: number;
	routeId: number;
	scheduleEntryId: number;
	fromIata: string;
	toIata: string;
	distanceKm: number;
	departAt: number;
	arriveAt: number;
	pax: ClassAmounts;
	/** Tonnes of freight carried; always zero for a passenger aircraft. */
	cargoTonnes: number;
	revenue: number;
	fuelCost: number;
	taxCost: number;
	status: FlightStatus;
}

export interface TransactionRecord {
	id: number;
	companyId: number;
	at: number;
	day: number;
	direction: TransactionDirection;
	category: TransactionCategory;
	amount: number;
	description: string;
	refId: string | null;
}

export interface Incident {
	id: number;
	companyId: number;
	aircraftId: number;
	aircraftName: string;
	flightId: number | null;
	at: number;
	passengers: number;
	baseAmount: number;
	status: IncidentStatus;
	outcome: string | null;
	finalAmount: number | null;
	resolvedAt: number | null;
}

export class GameDatabase extends Dexie {
	game_state!: EntityTable<GameState, 'id'>;
	companies!: EntityTable<Company, 'id'>;
	shareholdings!: EntityTable<Shareholding, 'id'>;
	share_listings!: EntityTable<ShareListing, 'id'>;
	share_trades!: EntityTable<ShareTrade, 'id'>;
	gate_ownership!: EntityTable<GateOwnership, 'gateKey'>;
	aircraft!: EntityTable<Aircraft, 'id'>;
	routes!: EntityTable<Route, 'id'>;
	route_audits!: EntityTable<RouteAudit, 'id'>;
	schedule_entries!: EntityTable<ScheduleEntry, 'id'>;
	flights!: EntityTable<Flight, 'id'>;
	transaction_records!: EntityTable<TransactionRecord, 'id'>;
	incidents!: EntityTable<Incident, 'id'>;
	brokers!: EntityTable<Broker, 'id'>;
	takeover_bids!: EntityTable<TakeoverBid, 'id'>;

	constructor() {
		super('airline-manager-simulator');

		// Version 1 shipped every stand as a row — fifteen thousand of them, all but a
		// handful unowned and identical to what the dataset already describes. Versions 2
		// and 3 replace that with an ownership table keyed by the stand's stable key.
		this.version(1).stores({
			game_state: 'id',
			companies: '++id, &slug, name, icao, controller, lastAiDay',
			shareholdings: '++id, companyId, holderId, [companyId+holderId]',
			share_listings: '++id, companyId, sellerId, pricePerShare',
			share_trades: '++id, companyId, at',
			gates: '++id, airportIata, ownerCompanyId, [airportIata+number], [ownerCompanyId+airportIata]',
			aircraft: '++id, companyId, status, deliveryAt, [companyId+status]',
			routes: '++id, companyId, fromIata, toIata, [fromIata+toIata], [companyId+fromIata]',
			route_audits: '++id, companyId, &[companyId+pairKey]',
			schedule_entries: '++id, companyId, aircraftId, routeId, [aircraftId+dayOfWeek]',
			flights: '++id, companyId, aircraftId, routeId, departAt, arriveAt, status, [companyId+status]',
			transaction_records: '++id, companyId, at, day, category, [companyId+day]',
			incidents: '++id, companyId, status, at, [companyId+status]'
		});

		this.version(2)
			.stores({
				gate_ownership: 'gateKey, companyId, airportIata, [companyId+airportIata]'
			})
			.upgrade(async (transaction) => {
				const legacy = (await transaction
					.table('gates')
					.toArray()) as LegacyGate[];

				const owned = legacy.filter((gate) => gate.ownerCompanyId !== 0);
				const keyByLegacyId = new Map<number, string>(
					legacy.map((gate) => [gate.id, `${gate.airportIata}-${gate.number}`])
				);

				await transaction.table('gate_ownership').bulkAdd(
					owned.map((gate) => ({
						gateKey: `${gate.airportIata}-${gate.number}`,
						airportIata: gate.airportIata,
						companyId: gate.ownerCompanyId,
						purchasedAt: gate.purchasedAt ?? 0
					}))
				);

				// Aircraft and routes referenced stands by the old numeric row id.
				await transaction
					.table('aircraft')
					.toCollection()
					.modify((aircraft: { homeGateId: unknown }) => {
						if (typeof aircraft.homeGateId === 'number') {
							aircraft.homeGateId = keyByLegacyId.get(aircraft.homeGateId) ?? '';
						}
					});

				await transaction
					.table('routes')
					.toCollection()
					.modify((route: { fromGateId: unknown; toGateId: unknown }) => {
						if (typeof route.fromGateId === 'number') {
							route.fromGateId = keyByLegacyId.get(route.fromGateId) ?? '';
						}
						if (typeof route.toGateId === 'number') {
							route.toGateId = keyByLegacyId.get(route.toGateId) ?? '';
						}
					});
			});

		// Only once the migration above has run can the old table go.
		this.version(3).stores({ gates: null });

		// Freight arrived with the cargo fleet: existing routes get a fair opening rate
		// and past flights are recorded as having carried nothing.
		this.version(4).upgrade(async (transaction) => {
			await transaction
				.table('routes')
				.toCollection()
				.modify((route: { distanceKm: number; cargoRatePerTonne?: number }) => {
					route.cargoRatePerTonne ??= Math.round(180 + 0.55 * route.distanceKm ** 0.9);
				});

			await transaction
				.table('flights')
				.toCollection()
				.modify((flight: { cargoTonnes?: number }) => {
					flight.cargoTonnes ??= 0;
				});
		});

		// Broker desks. Purely additive, so there is nothing to migrate — `ensureBrokers`
		// fills the table on every boot, which is what gets desks into worlds that already
		// exist. `key` is unique so that backfill can be idempotent.
		this.version(5).stores({ brokers: '++id, &key' });

		// Takeover bids. Additive like the desks before them, so there is nothing to migrate:
		// an airline that has never been bid for simply has no row. `[targetCompanyId+status]`
		// answers "is there an open bid on this airline" for the dossier, and `status` alone
		// answers "every bid still open" for the daily pass.
		this.version(6).stores({
			takeover_bids: '++id, targetCompanyId, bidderHolderId, status, [targetCompanyId+status]'
		});
	}
}

export const db = new GameDatabase();

/** Stable key for an unordered airport pair, so A→B and B→A share demand. */
export const pairKeyOf = (fromIata: string, toIata: string): string =>
	[fromIata, toIata].sort().join('-');

export const companyHolderId = (companyId: number): string => `c:${companyId}`;

/** The airline behind a `c:N` holder id, or null for the player and anything unrecognised. */
export const holderCompanyId = (holderId: string): number | null => {
	if (!holderId.startsWith('c:')) return null;
	const parsed = Number(holderId.slice(2));

	return Number.isInteger(parsed) ? parsed : null;
};

/**
 * Whether the AI takes this airline's daily decisions. Two ways in: nobody owns it, or its
 * owner hired a chief executive to run it. The player still owns a CEO-run airline outright,
 * which is exactly why this is not the same question as `controller`.
 */
export const isAiRun = (company: Pick<Company, 'controller' | 'ceoHired'>): boolean =>
	company.controller === 'ai' || (company.ceoHired ?? false);

export const brokerHolderId = (brokerId: number): string => `b:${brokerId}`;

/** The desk behind a `b:N` holder id, or null for anything that is not one. */
export const holderBrokerId = (holderId: string): number | null => {
	if (!holderId.startsWith('b:')) return null;
	const parsed = Number(holderId.slice(2));

	return Number.isInteger(parsed) ? parsed : null;
};
