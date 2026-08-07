import { describe, expect, it } from 'vitest';
import type { TransactionCategory, TransactionRecord } from '$db/schema';
import {
	CATEGORY_GROUP,
	CATEGORY_LABELS,
	P_AND_L_DAYS,
	groupByDay,
	groupOf,
	summariseLedger,
	trailingWindow
} from './ledger';

let nextId = 1;

const record = (overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
	id: nextId++,
	companyId: 1,
	at: 1_000,
	day: 10,
	direction: 'income',
	category: 'ticket_sales',
	amount: 1_000,
	description: 'Test movement',
	refId: null,
	...overrides
});

describe('ledger helpers', () => {
	describe('WHEN grouping a category', () => {
		it.each`
			category                    | expected
			${'ticket_sales'}           | ${'revenue'}
			${'freight_sales'}          | ${'revenue'}
			${'fuel'}                   | ${'operating'}
			${'airport_tax'}            | ${'operating'}
			${'wages'}                  | ${'operating'}
			${'hiring_fee'}             | ${'operating'}
			${'maintenance'}            | ${'operating'}
			${'aircraft_lease'}         | ${'operating'}
			${'incident_settlement'}    | ${'exceptional'}
			${'incident_lawsuit'}       | ${'exceptional'}
			${'aircraft_purchase'}      | ${'investing'}
			${'aircraft_sale'}          | ${'investing'}
			${'aircraft_lease_deposit'} | ${'investing'}
			${'gate_purchase'}          | ${'investing'}
			${'route_setup'}            | ${'investing'}
			${'route_audit'}            | ${'investing'}
			${'share_purchase'}         | ${'financing'}
			${'share_sale'}             | ${'financing'}
		`('should put $category on the $expected statement', ({ category, expected }) => {
			const result = groupOf(category as TransactionCategory);

			expect(result).toBe(expected);
		});

		it('should classify every category the schema defines', () => {
			const labelled = Object.keys(CATEGORY_LABELS) as TransactionCategory[];

			const unclassified = labelled.filter((category) => !CATEGORY_GROUP[category]);

			expect(unclassified).toEqual([]);
			expect(labelled).toHaveLength(18);
		});
	});

	describe('WHEN an airline bought an aircraft inside the window', () => {
		it('should leave the purchase out of the operating result', () => {
			const records = [
				record({ category: 'ticket_sales', amount: 1_000_000 }),
				record({ category: 'aircraft_purchase', amount: -200_000_000 })
			];

			const result = summariseLedger(records, { fromDay: 10, toDay: 10 });

			expect(result.operatingResult).toBe(1_000_000);
			expect(result.investing).toBe(-200_000_000);
			expect(result.netCashMovement).toBe(-199_000_000);
		});

		it('should count a lease payment as operating but its deposit as investing', () => {
			const records = [
				record({ category: 'aircraft_lease', amount: -45_000 }),
				record({ category: 'aircraft_lease_deposit', amount: -1_370_000 })
			];

			const result = summariseLedger(records, { fromDay: 10, toDay: 10 });

			expect(result.operatingCost).toBe(-45_000);
			expect(result.investing).toBe(-1_370_000);
		});
	});

	describe('WHEN summarising a ledger', () => {
		it('should split income from expenses off the sign of the amount', () => {
			const records = [
				record({ amount: 500 }),
				record({ amount: -200, category: 'fuel' }),
				record({ amount: -300, category: 'wages' })
			];

			const result = summariseLedger(records, { fromDay: 10, toDay: 10 });

			expect(result.income).toBe(500);
			expect(result.expense).toBe(-500);
			expect(result.netCashMovement).toBe(0);
		});

		it('should count a zero-amount movement as neither income nor expense', () => {
			const records = [record({ amount: 0 })];

			const result = summariseLedger(records, { fromDay: 10, toDay: 10 });

			expect(result.income).toBe(0);
			expect(result.expense).toBe(0);
			expect(result.entryCount).toBe(1);
		});

		it('should ignore movements outside the window', () => {
			const records = [
				record({ day: 5, amount: 900_000 }),
				record({ day: 10, amount: 100_000 }),
				record({ day: 99, amount: 900_000 })
			];

			const result = summariseLedger(records, { fromDay: 9, toDay: 11 });

			expect(result.entryCount).toBe(1);
			expect(result.operatingRevenue).toBe(100_000);
		});

		it('should report every group even when nothing landed in it', () => {
			const result = summariseLedger([], { fromDay: 0, toDay: 0 });

			expect(result.groups.map((group) => group.group)).toEqual([
				'revenue',
				'operating',
				'exceptional',
				'investing',
				'financing'
			]);
			expect(result.groups.every((group) => group.amount === 0)).toBe(true);
		});

		it('should hold every figure finite on an empty ledger', () => {
			const result = summariseLedger([], { fromDay: 0, toDay: 27 });

			expect(result.daysCovered).toBeGreaterThanOrEqual(1);
			expect(result.dailyOperatingResult).toBe(0);
			expect(result.dailyRevenue).toBe(0);
			expect(Number.isFinite(result.dailyOperatingResult)).toBe(true);
		});

		it('should order the lines inside a group by size', () => {
			const records = [
				record({ category: 'fuel', amount: -100 }),
				record({ category: 'wages', amount: -900 }),
				record({ category: 'maintenance', amount: -400 })
			];

			const result = summariseLedger(records, { fromDay: 10, toDay: 10 });
			const operating = result.groups.find((group) => group.group === 'operating');

			expect(operating?.categories.map((line) => line.category)).toEqual([
				'wages',
				'maintenance',
				'fuel'
			]);
		});

		it('should count how many movements each category holds', () => {
			const records = [
				record({ category: 'fuel', amount: -100 }),
				record({ category: 'fuel', amount: -150 })
			];

			const result = summariseLedger(records, { fromDay: 10, toDay: 10 });
			const fuel = result.groups
				.find((group) => group.group === 'operating')
				?.categories.find((line) => line.category === 'fuel');

			expect(fuel?.amount).toBe(-250);
			expect(fuel?.count).toBe(2);
		});
	});

	describe('WHEN sizing the trailing window', () => {
		it('should stop before today, since today is only half traded', () => {
			const result = trailingWindow(100);

			expect(result.toDay).toBe(99);
		});

		it('should span four whole weeks by default', () => {
			const result = trailingWindow(100);

			expect(result.toDay - result.fromDay + 1).toBe(P_AND_L_DAYS);
			expect(P_AND_L_DAYS % 7).toBe(0);
		});

		it('should not reach back past the airline’s first day', () => {
			const result = trailingWindow(100, 28, 90);

			expect(result.fromDay).toBe(90);
		});

		it('should collapse to a single day for an airline founded today', () => {
			const result = trailingWindow(100, 28, 100);
			const summary = summariseLedger([], result);

			expect(result.fromDay).toBe(result.toDay);
			expect(summary.daysCovered).toBe(1);
			expect(Number.isFinite(summary.dailyOperatingResult)).toBe(true);
		});
	});

	describe('WHEN grouping by day', () => {
		it('should list the newest day first', () => {
			const records = [record({ day: 4 }), record({ day: 9 }), record({ day: 7 })];

			const result = groupByDay(records);

			expect(result.map((summary) => summary.day)).toEqual([9, 7, 4]);
		});

		it('should list the newest movement first inside a day', () => {
			const records = [
				record({ day: 3, at: 100, description: 'first' }),
				record({ day: 3, at: 900, description: 'last' })
			];

			const result = groupByDay(records);

			expect(result[0].records.map((entry) => entry.description)).toEqual(['last', 'first']);
		});

		it('should leave the array it was given untouched', () => {
			const records = [
				record({ day: 3, at: 100 }),
				record({ day: 3, at: 900 }),
				record({ day: 1, at: 500 })
			];
			const order = records.map((entry) => entry.id);

			groupByDay(records);

			expect(records.map((entry) => entry.id)).toEqual(order);
		});

		it('should total each day on its own', () => {
			const records = [
				record({ day: 3, amount: 500 }),
				record({ day: 3, amount: -200, category: 'fuel' }),
				record({ day: 2, amount: 100 })
			];

			const result = groupByDay(records);

			expect(result[0]).toMatchObject({ day: 3, income: 500, expense: -200 });
			expect(result[1]).toMatchObject({ day: 2, income: 100, expense: 0 });
		});
	});
});
