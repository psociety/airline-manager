import { setClockOffset } from '$engine/clock';
import { db } from './schema';
import { ensureBrokers } from './seed';

export const SAVE_FORMAT = 'airline-manager-simulator-save';

/**
 * Only moves when an existing table's *shape* changes, never when a table is added.
 * `upgradeLegacySave` treats anything below this version as a version 1 save and runs the
 * gates conversion on it, so bumping this for an additive change would take every save
 * already in the wild, find no `tables.gates` to convert, and write an empty
 * `gate_ownership` — wiping every stand the player owns. A new table needs nothing but an
 * entry in `TABLE_NAMES`: `importSave` skips a key that isn't there.
 */
export const SAVE_VERSION = 2;

export interface SaveFile {
	format: typeof SAVE_FORMAT;
	version: number;
	exportedAt: string;
	tables: Record<string, unknown[]>;
}

/** Every table, in the order they have to be restored. */
const TABLE_NAMES = [
	'game_state',
	'companies',
	'brokers',
	'shareholdings',
	'share_listings',
	'share_trades',
	'takeover_bids',
	'gate_ownership',
	'aircraft',
	'routes',
	'route_audits',
	'schedule_entries',
	'flights',
	'transaction_records',
	'incidents'
] as const;

/** Dumps the whole world to a JSON string that can be handed to someone else. */
export const exportSave = async (): Promise<string> => {
	const tables: Record<string, unknown[]> = {};

	for (const name of TABLE_NAMES) {
		tables[name] = await db.table(name).toArray();
	}

	const save: SaveFile = {
		format: SAVE_FORMAT,
		version: SAVE_VERSION,
		exportedAt: new Date().toISOString(),
		tables
	};

	return JSON.stringify(save);
};

export class SaveFileError extends Error {}

export const parseSave = (contents: string): SaveFile => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		throw new SaveFileError('That file is not valid JSON');
	}

	const save = parsed as Partial<SaveFile>;
	if (save?.format !== SAVE_FORMAT) {
		throw new SaveFileError('That file is not an Airline Manager Simulator save');
	}
	if (save.version !== SAVE_VERSION && save.version !== 1) {
		throw new SaveFileError(`Unsupported save version: ${String(save.version)}`);
	}
	if (!save.tables || typeof save.tables !== 'object') {
		throw new SaveFileError('That save has no table data');
	}

	return save as SaveFile;
};

/**
 * Replaces the current world with the contents of a save file. Everything goes:
 * the point is to reproduce somebody else's game exactly, not to merge into yours.
 */
/**
 * Version 1 saves carry every stand as a row and reference them by numeric id. This
 * turns them into the ownership rows and gate keys the current schema uses — the same
 * conversion the IndexedDB migration performs, applied to a file.
 */
const upgradeLegacySave = (save: SaveFile): SaveFile => {
	if (save.version === SAVE_VERSION) return save;

	const legacy = (save.tables.gates ?? []) as {
		id: number;
		airportIata: string;
		number: string;
		ownerCompanyId: number;
		purchasedAt: number | null;
	}[];

	const keyById = new Map(legacy.map((gate) => [gate.id, `${gate.airportIata}-${gate.number}`]));
	const tables: Record<string, unknown[]> = { ...save.tables };
	delete tables.gates;

	tables.gate_ownership = legacy
		.filter((gate) => gate.ownerCompanyId !== 0)
		.map((gate) => ({
			gateKey: `${gate.airportIata}-${gate.number}`,
			airportIata: gate.airportIata,
			companyId: gate.ownerCompanyId,
			purchasedAt: gate.purchasedAt ?? 0
		}));

	tables.aircraft = ((save.tables.aircraft ?? []) as { homeGateId: unknown }[]).map(
		(aircraft) => ({
			...aircraft,
			homeGateId:
				typeof aircraft.homeGateId === 'number'
					? (keyById.get(aircraft.homeGateId) ?? '')
					: aircraft.homeGateId
		})
	);

	tables.routes = ((save.tables.routes ?? []) as { fromGateId: unknown; toGateId: unknown }[]).map(
		(route) => ({
			...route,
			fromGateId:
				typeof route.fromGateId === 'number'
					? (keyById.get(route.fromGateId) ?? '')
					: route.fromGateId,
			toGateId:
				typeof route.toGateId === 'number' ? (keyById.get(route.toGateId) ?? '') : route.toGateId
		})
	);

	return { ...save, version: SAVE_VERSION, tables };
};

export const importSave = async (contents: string): Promise<void> => {
	const save = upgradeLegacySave(parseSave(contents));

	await db.transaction('rw', db.tables, async () => {
		for (const name of TABLE_NAMES) {
			await db.table(name).clear();
		}
		for (const name of TABLE_NAMES) {
			const rows = save.tables[name];
			if (Array.isArray(rows) && rows.length > 0) await db.table(name).bulkAdd(rows);
		}
	});

	// The world clock offset lives in game_state, so it has to be re-applied.
	const state = await db.game_state.get(1);
	setClockOffset(state?.clockOffsetMs ?? 0);

	// A save written before desks existed clears the table and puts nothing back.
	await ensureBrokers();

};

export const saveFileName = (): string =>
  `airline-manager-save-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
