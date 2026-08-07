export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * The world clock runs at real-time 1:1, but can be pushed ahead of wall time by a
 * persisted offset. That offset is what the dev fast-forward moves: time genuinely
 * advances into the future instead of replaying history, so nothing is simulated twice.
 */
let clockOffsetMs = 0;

export const setClockOffset = (offset: number): void => {
	clockOffsetMs = offset;
};

export const getClockOffset = (): number => clockOffsetMs;

/** Current world time. Use this everywhere instead of `Date.now()`. */
export const gameNow = (): number => Date.now() + clockOffsetMs;

/** Whole days since the unix epoch (UTC). Used as the game's day key. */
export const dayIndexOf = (timestamp: number): number => Math.floor(timestamp / DAY_MS);

export const startOfDay = (dayIndex: number): number => dayIndex * DAY_MS;

/** 0 = Monday … 6 = Sunday. Epoch day 0 was a Thursday. */
export const dayOfWeekOf = (dayIndex: number): number => (((dayIndex + 3) % 7) + 7) % 7;

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const DAY_NAMES_LONG = [
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
	'Sunday'
] as const;

/** Timestamp of `hour` on the given day. */
export const timeAt = (dayIndex: number, hour: number): number => startOfDay(dayIndex) + hour * HOUR_MS;

export const dayKey = (dayIndex: number): string =>
	new Date(startOfDay(dayIndex)).toISOString().slice(0, 10);

export const formatClock = (timestamp: number): string =>
	new Date(timestamp).toISOString().slice(11, 16);

export const formatDateTime = (timestamp: number): string => {
	const date = new Date(timestamp);
	return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
};

export const formatDuration = (milliseconds: number): string => {
	if (milliseconds <= 0) return 'now';
	const totalMinutes = Math.floor(milliseconds / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	return `${minutes}m ${String(Math.floor((milliseconds % 60_000) / 1000)).padStart(2, '0')}s`;
};

export const formatHours = (hours: number): string => {
	const whole = Math.floor(hours);
	const minutes = Math.round((hours - whole) * 60);
	return `${whole}h ${String(minutes).padStart(2, '0')}m`;
};
