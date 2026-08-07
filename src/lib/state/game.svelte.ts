import { db } from '$db/schema';
import { seedWorld } from '$db/seed';
import { GameError } from '$db/repo';
import { gameNow, setClockOffset } from '$engine/clock';
import { catchUp, type CatchUpSummary } from '$engine/tick';

const UI_REFRESH_MS = 1_000;
const SIM_REFRESH_MS = 15_000;

export type ToastKind = 'info' | 'error' | 'warning';

export interface Toast {
	id: number;
	message: string;
	kind: ToastKind;
}

/**
 * Owns the world clock, the simulation heartbeat and the revision counter every
 * screen watches to know when to reload its data.
 */
class GameStore {
	now = $state(gameNow());
	revision = $state(0);
	booted = $state(false);
	bootError = $state<string | null>(null);
	awaySummary = $state<CatchUpSummary | null>(null);
	toasts = $state<Toast[]>([]);

	#bootPromise: Promise<void> | null = null;
	#uiTimer: ReturnType<typeof setInterval> | null = null;
	#simTimer: ReturnType<typeof setInterval> | null = null;
	#toastId = 0;

	boot(): Promise<void> {
		this.#bootPromise ??= this.#doBoot();
		return this.#bootPromise;
	}

	async #doBoot(): Promise<void> {
		try {
			await db.open();
			await seedWorld();

			// Restore any fast-forward the player applied in an earlier session, so the
			// world clock keeps running from where it was rather than snapping back.
			const state = await db.game_state.get(1);
			setClockOffset(state?.clockOffsetMs ?? 0);

			const summary = await catchUp();
			if (summary.daysProcessed > 0 || summary.flightsFlown > 0) {
				this.awaySummary = summary;
			}

			this.booted = true;
			this.revision += 1;
			this.#startTimers();
		} catch (error) {
			this.bootError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	#startTimers(): void {
		this.#uiTimer ??= setInterval(() => {
			this.now = gameNow();
		}, UI_REFRESH_MS);

		this.#simTimer ??= setInterval(() => {
			void this.advance();
		}, SIM_REFRESH_MS);
	}

	/** Runs the simulation forward and tells every screen to reload. */
	async advance(): Promise<void> {
		const summary = await catchUp();
		this.now = gameNow();
		if (summary.flightsFlown > 0 || summary.daysProcessed > 0) this.revision += 1;
	}

	/** Forces a reload of every screen, after a player action changed the world. */
	invalidate(): void {
		this.revision += 1;
	}

	toast(message: string, kind: ToastKind = 'info'): void {
		this.#toastId += 1;
		const id = this.#toastId;
		this.toasts = [...this.toasts, { id, message, kind }];
		setTimeout(() => this.dismiss(id), 5_000);
	}

	dismiss(id: number): void {
		this.toasts = this.toasts.filter((toast) => toast.id !== id);
	}

	/**
	 * Runs a player action, surfacing game rule violations as toasts rather than
	 * crashes, and refreshing the UI afterwards.
	 */
	async act<T>(action: () => Promise<T>, successMessage?: string): Promise<T | null> {
		try {
			const result = await action();
			if (successMessage) this.toast(successMessage);
			this.invalidate();
			return result;
		} catch (error) {
			const message =
				error instanceof GameError
					? error.message
					: error instanceof Error
						? error.message
						: 'Something went wrong';
			this.toast(message, 'error');
			return null;
		}
	}

	dismissAwaySummary(): void {
		this.awaySummary = null;
	}

	/**
	 * Development helper: push the world clock forward. This moves time into the
	 * future rather than replaying the past, so the catch-up simulates each new hour
	 * exactly once — flights fly, days close, the AI takes its turns.
	 */
	async fastForward(hours: number): Promise<CatchUpSummary> {
		const state = await db.game_state.get(1);
		if (!state) throw new Error('World not seeded');

		const clockOffsetMs = state.clockOffsetMs + hours * 3_600_000;
		await db.game_state.update(1, { clockOffsetMs });
		setClockOffset(clockOffsetMs);

		const summary = await catchUp();
		this.now = gameNow();
		this.revision += 1;
		return summary;
	}
}

export const game = new GameStore();
