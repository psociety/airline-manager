import type { TransactionCategory, TransactionRecord } from '$db/schema';

export const CATEGORY_LABELS: Record<TransactionCategory, string> = {
	aircraft_purchase: 'Aircraft purchase',
	aircraft_lease_deposit: 'Lease deposit',
	aircraft_lease: 'Lease payments',
	aircraft_sale: 'Aircraft sale',
	gate_purchase: 'Gate purchase',
	route_setup: 'Route set-up',
	route_audit: 'Market audit',
	ticket_sales: 'Ticket sales',
	freight_sales: 'Freight sales',
	fuel: 'Fuel',
	airport_tax: 'Airport charges',
	wages: 'Wages',
	hiring_fee: 'Hiring fees',
	maintenance: 'Maintenance',
	incident_settlement: 'Accident indemnity',
	incident_lawsuit: 'Lawsuit damages',
	share_purchase: 'Share purchase',
	share_sale: 'Share sale'
};

export type LedgerGroup = 'revenue' | 'operating' | 'exceptional' | 'investing' | 'financing';

export const GROUP_LABELS: Record<LedgerGroup, string> = {
	revenue: 'Operating revenue',
	operating: 'Operating costs',
	exceptional: 'Exceptional items',
	investing: 'Investing',
	financing: 'Financing'
};

/** The order statements are read in: earnings first, then what was bought, then funding. */
export const LEDGER_GROUPS: LedgerGroup[] = [
	'revenue',
	'operating',
	'exceptional',
	'investing',
	'financing'
];

/**
 * Which statement a movement belongs on. Judging what an airline earns means telling
 * trading apart from the week it happened to buy an aircraft, so:
 *
 * - `aircraft_lease` is operating — daily rental is a cost of flying — while
 *   `aircraft_lease_deposit` is investing, a one-off outlay. Counting the deposit as an
 *   operating cost makes a fleet expansion read as a collapse in earnings.
 * - `route_setup` and `route_audit` are investing because the assets statement credits
 *   every live route its goodwill; charging them against earnings too would count the
 *   same euro twice.
 * - accidents get their own group. The cash is real, but it is lumpy, so earning power
 *   should be legible before it and cash reality after it.
 *
 * Exhaustive by type, so a nineteenth category cannot be added without deciding where
 * it belongs.
 */
export const CATEGORY_GROUP: Record<TransactionCategory, LedgerGroup> = {
	ticket_sales: 'revenue',
	freight_sales: 'revenue',
	fuel: 'operating',
	airport_tax: 'operating',
	wages: 'operating',
	hiring_fee: 'operating',
	maintenance: 'operating',
	aircraft_lease: 'operating',
	incident_settlement: 'exceptional',
	incident_lawsuit: 'exceptional',
	aircraft_purchase: 'investing',
	aircraft_sale: 'investing',
	aircraft_lease_deposit: 'investing',
	gate_purchase: 'investing',
	route_setup: 'investing',
	route_audit: 'investing',
	share_purchase: 'financing',
	share_sale: 'financing'
};

export const groupOf = (category: TransactionCategory): LedgerGroup => CATEGORY_GROUP[category];

/**
 * Four whole weeks. Schedules repeat by day of week, so a window that is not a multiple
 * of seven counts some weekdays more often than others — a route flown only on Mondays
 * would be overstated by a quarter across thirty days.
 */
export const P_AND_L_DAYS = 28;

/** Inclusive at both ends. */
export interface LedgerWindow {
	fromDay: number;
	toDay: number;
}

/**
 * The last `days` complete days. Today is left out because wages post at midnight while
 * revenue accrues through the day, so a partial day drags every average down. Clamped to
 * the airline's first day, since a carrier founded on Tuesday has not traded for a month.
 */
export const trailingWindow = (
	today: number,
	days = P_AND_L_DAYS,
	inceptionDay = Number.NEGATIVE_INFINITY
): LedgerWindow => {
	const toDay = today - 1;
	const earliest = Math.max(toDay - days + 1, inceptionDay);

	return { fromDay: Math.min(earliest, toDay), toDay };
};

export interface CategoryTotal {
	category: TransactionCategory;
	amount: number;
	count: number;
}

export interface GroupTotal {
	group: LedgerGroup;
	amount: number;
	categories: CategoryTotal[];
}

export interface ProfitAndLoss {
	window: LedgerWindow;
	/** Never below one, so every per-day figure is finite. */
	daysCovered: number;
	entryCount: number;
	income: number;
	expense: number;
	groups: GroupTotal[];
	operatingRevenue: number;
	operatingCost: number;
	/** What the airline earns by flying, before accidents and before anything it bought. */
	operatingResult: number;
	exceptional: number;
	investing: number;
	financing: number;
	netCashMovement: number;
	dailyOperatingResult: number;
	dailyRevenue: number;
}

const inWindow = (record: TransactionRecord, window: LedgerWindow): boolean =>
	record.day >= window.fromDay && record.day <= window.toDay;

/** Largest movement first, so the line that explains a result is at the top. */
const byAbsoluteAmount = (left: CategoryTotal, right: CategoryTotal): number =>
	Math.abs(right.amount) - Math.abs(left.amount);

const totalCategories = (records: TransactionRecord[]): CategoryTotal[] => {
	const totals = new Map<TransactionCategory, CategoryTotal>();

	for (const record of records) {
		const existing = totals.get(record.category);
		if (existing) {
			existing.amount += record.amount;
			existing.count += 1;
		} else {
			totals.set(record.category, { category: record.category, amount: record.amount, count: 1 });
		}
	}

	return [...totals.values()].sort(byAbsoluteAmount);
};

/**
 * Income, expenses and per-group totals for a set of ledger rows. Sums off the sign of
 * `amount` rather than `direction`, which `postTransaction` derives from that sign anyway
 * and which labels a zero-amount row as income.
 *
 * Filters to `window` itself, so passing a wider set of records than the window is safe.
 */
export const summariseLedger = (
	records: TransactionRecord[],
	window?: LedgerWindow
): ProfitAndLoss => {
	const days = records.map((record) => record.day);
	const span = window ?? {
		fromDay: days.length > 0 ? Math.min(...days) : 0,
		toDay: days.length > 0 ? Math.max(...days) : 0
	};
	const inside = records.filter((record) => inWindow(record, span));

	const byGroup = new Map<LedgerGroup, TransactionRecord[]>();
	for (const record of inside) {
		const group = groupOf(record.category);
		const list = byGroup.get(group);
		if (list) list.push(record);
		else byGroup.set(group, [record]);
	}

	const groups = LEDGER_GROUPS.map((group) => {
		const groupRecords = byGroup.get(group) ?? [];
		return {
			group,
			amount: groupRecords.reduce((sum, record) => sum + record.amount, 0),
			categories: totalCategories(groupRecords)
		} satisfies GroupTotal;
	});

	const amountOf = (group: LedgerGroup): number =>
		groups.find((total) => total.group === group)?.amount ?? 0;

	const operatingRevenue = amountOf('revenue');
	const operatingCost = amountOf('operating');
	const daysCovered = Math.max(1, span.toDay - span.fromDay + 1);
	const operatingResult = operatingRevenue + operatingCost;

	return {
		window: span,
		daysCovered,
		entryCount: inside.length,
		income: inside.filter((record) => record.amount > 0).reduce((sum, r) => sum + r.amount, 0),
		expense: inside.filter((record) => record.amount < 0).reduce((sum, r) => sum + r.amount, 0),
		groups,
		operatingRevenue,
		operatingCost,
		operatingResult,
		exceptional: amountOf('exceptional'),
		investing: amountOf('investing'),
		financing: amountOf('financing'),
		netCashMovement: inside.reduce((sum, record) => sum + record.amount, 0),
		dailyOperatingResult: operatingResult / daysCovered,
		dailyRevenue: operatingRevenue / daysCovered
	};
};

export interface DaySummary {
	day: number;
	income: number;
	expense: number;
	/** Newest first. */
	records: TransactionRecord[];
	byCategory: CategoryTotal[];
}

/** The same rollup grouped by game day, newest day first. Never mutates its input. */
export const groupByDay = (records: TransactionRecord[]): DaySummary[] => {
	const grouped = new Map<number, TransactionRecord[]>();
	for (const record of records) {
		const list = grouped.get(record.day);
		if (list) list.push(record);
		else grouped.set(record.day, [record]);
	}

	return [...grouped.entries()]
		.sort((left, right) => right[0] - left[0])
		.map(([day, dayRecords]) => ({
			day,
			income: dayRecords.filter((record) => record.amount > 0).reduce((sum, r) => sum + r.amount, 0),
			expense: dayRecords.filter((record) => record.amount < 0).reduce((sum, r) => sum + r.amount, 0),
			records: [...dayRecords].sort((left, right) => right.at - left.at),
			byCategory: totalCategories(dayRecords)
		}));
};
