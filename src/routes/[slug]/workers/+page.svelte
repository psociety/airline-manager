<script lang="ts">
	import { page } from '$app/stores';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { getModel } from '$data/aircraft';
	import { companyFleet, companyGateCount, fireCeo, hireCeo, hireWorkers, sharesHeldBy } from '$db/repo';
	import {
		CONTROL_THRESHOLD,
		EMPLOYEES_PER_GATE,
		EMPLOYEES_PER_ROUTE,
		EXTERNAL_WORKER_DAILY_COST,
		HIRED_WORKER_DAILY_COST,
		HIRING_FEE,
		PLAYER_HOLDER_ID,
		TOTAL_SHARES,
		db,
		type Company
	} from '$db/schema';
	import { dailyWageBill, hiringCost } from '$engine/economy';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import { BadgeCheck, Briefcase, Coins, UserPlus, Users } from 'lucide-svelte';

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let breakdown = $state({ aircraft: 0, routes: 0, gates: 0 });
	let toHire = $state(0);
	let submitting = $state(false);
	let playerShares = $state(0);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;

			const fleet = await companyFleet(found.id);
			const routeCount = await db.routes.where('companyId').equals(found.id).count();
			const gateCount = await companyGateCount(found.id);

			breakdown = {
				aircraft: fleet.reduce((sum, aircraft) => sum + getModel(aircraft.modelId).employees, 0),
				routes: routeCount * EMPLOYEES_PER_ROUTE,
				gates: gateCount * EMPLOYEES_PER_GATE
			};

			playerShares = await sharesHeldBy(found.id, PLAYER_HOLDER_ID);

			if (toHire > found.external_workers) toHire = found.external_workers;
		})();
	});

	const totalWorkers = $derived(
		company ? company.external_workers + company.hired_workers : 0
	);
	const currentDailyBill = $derived(company ? dailyWageBill(company) : 0);

	/** What the daily bill becomes once `toHire` externals move onto the payroll. */
	const projectedDailyBill = $derived(
		company
			? dailyWageBill({
					external_workers: company.external_workers - toHire,
					hired_workers: company.hired_workers + toHire
				})
			: 0
	);
	const dailySaving = $derived(currentDailyBill - projectedDailyBill);
	const upfront = $derived(hiringCost(toHire));
	const paybackDays = $derived(dailySaving > 0 ? Math.ceil(upfront / dailySaving) : 0);

	const ceoHired = $derived(company?.ceoHired ?? false);
	const controlsIt = $derived(playerShares > CONTROL_THRESHOLD);
	const stakePercent = $derived((playerShares / TOTAL_SHARES) * 100);
	/**
	 * One share a day, and the CEO is dismissed the moment the stake stops being a majority —
	 * so the shares above half the register are exactly the days the player can afford.
	 */
	const daysAfforded = $derived(Math.max(0, playerShares - CONTROL_THRESHOLD));

	const confirmHireCeo = async (): Promise<void> => {
		if (!company || !controlsIt) return;

		const question =
			`Hire a chief executive for one share a day?\n\n` +
			`Your ${playerShares.toLocaleString('de-DE')} shares cover ${daysAfforded.toLocaleString('de-DE')} day(s). ` +
			`After that your stake stops being a majority, the CEO is dismissed and the airline goes to its own management.`;
		if (!confirm(question)) return;

		submitting = true;
		await game.act(() => hireCeo(company!.id), 'A chief executive takes over tomorrow');
		submitting = false;
	};

	const confirmFireCeo = async (): Promise<void> => {
		if (!company) return;
		submitting = true;

		await game.act(() => fireCeo(company!.id), 'The chief executive has been dismissed');

		submitting = false;
	};

	const confirmHire = async (): Promise<void> => {
		if (!company || toHire <= 0) return;
		submitting = true;

		await game.act(
			() => hireWorkers(company!.id, toHire),
			`${toHire} worker${toHire === 1 ? '' : 's'} moved onto the payroll`
		);

		toHire = 0;
		submitting = false;
	};
</script>

<PageHeader title="WORKERS" subtitle="{totalWorkers.toLocaleString('de-DE')} people keep the airline running">
	{#snippet stats()}
		<StatBox
			icon={Coins}
			value="{Math.round(currentDailyBill).toLocaleString('de-DE')} €"
			label="Daily wage bill"
		/>
	{/snippet}
</PageHeader>

{#if company}
	<div class="e-grid-two">
		<div class="e-panel">
			<h3 class="e-panel__title"><Users size={14} /> Headcount</h3>

			<div class="e-kv">
				<span class="e-kv__key">External workers</span>
				<span class="e-kv__value">{company.external_workers.toLocaleString('de-DE')}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Hired workers</span>
				<span class="e-kv__value">{company.hired_workers.toLocaleString('de-DE')}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Total</span>
				<span class="e-kv__value">{totalWorkers.toLocaleString('de-DE')}</span>
			</div>

			<h4 class="e-workers__subtitle">Where the headcount comes from</h4>
			<div class="e-kv">
				<span class="e-kv__key">Aircraft crews</span>
				<span class="e-kv__value">{breakdown.aircraft.toLocaleString('de-DE')}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Routes ({EMPLOYEES_PER_ROUTE} each)</span>
				<span class="e-kv__value">{breakdown.routes.toLocaleString('de-DE')}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Gates ({EMPLOYEES_PER_GATE} each)</span>
				<span class="e-kv__value">{breakdown.gates.toLocaleString('de-DE')}</span>
			</div>

			<h4 class="e-workers__subtitle">Daily rates</h4>
			<div class="e-kv">
				<span class="e-kv__key">External worker</span>
				<span class="e-kv__value">{EXTERNAL_WORKER_DAILY_COST} €/day</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Hired worker</span>
				<span class="e-kv__value">{HIRED_WORKER_DAILY_COST} €/day</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">One-off hiring fee</span>
				<span class="e-kv__value">{HIRING_FEE} € per hire</span>
			</div>
		</div>

		<div class="e-panel">
			<h3 class="e-panel__title"><UserPlus size={14} /> Hire externals</h3>

			{#if company.external_workers === 0}
				<p class="e-workers__note">
					Every worker is already on the payroll. New aircraft, routes and gates add externals you
					can hire later.
				</p>
			{:else}
				<p class="e-workers__note">
					Hiring costs {HIRING_FEE} € once, then {HIRED_WORKER_DAILY_COST} €/day instead of
					{EXTERNAL_WORKER_DAILY_COST} €/day — cheaper from day
					{Math.ceil(HIRING_FEE / (EXTERNAL_WORKER_DAILY_COST - HIRED_WORKER_DAILY_COST))} onwards.
				</p>

				<div class="e-field">
					<label class="e-field__label" for="hire-count">
						Hire {toHire.toLocaleString('de-DE')} of {company.external_workers.toLocaleString('de-DE')} externals
					</label>
					<input
						id="hire-count"
						type="range"
						min="0"
						max={company.external_workers}
						bind:value={toHire}
					/>
					<div class="e-workers__quick">
						<button class="e-button e-button--small" type="button" onclick={() => (toHire = 0)}>
							None
						</button>
						<button
							class="e-button e-button--small"
							type="button"
							onclick={() => (toHire = Math.floor(company!.external_workers / 4))}
						>
							25%
						</button>
						<button
							class="e-button e-button--small"
							type="button"
							onclick={() => (toHire = Math.floor(company!.external_workers / 2))}
						>
							50%
						</button>
						<button
							class="e-button e-button--small"
							type="button"
							onclick={() => (toHire = company!.external_workers)}
						>
							All
						</button>
					</div>
				</div>

				<div class="e-kv">
					<span class="e-kv__key">Hiring fee due now</span>
					<span class="e-kv__value"><Money amount={upfront} /></span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Daily bill after hiring</span>
					<span class="e-kv__value"><Money amount={projectedDailyBill} /></span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Daily saving</span>
					<span class="e-kv__value"><Money amount={dailySaving} /></span>
				</div>
				{#if paybackDays > 0}
					<div class="e-kv">
						<span class="e-kv__key">Pays for itself in</span>
						<span class="e-kv__value">{paybackDays} day{paybackDays === 1 ? '' : 's'}</span>
					</div>
				{/if}

				<button
					class="e-button e-button--primary e-button--block e-workers__submit"
					type="button"
					disabled={submitting || toHire <= 0 || company.cash < upfront}
					onclick={confirmHire}
				>
					<BadgeCheck size={16} />
					{company.cash < upfront
						? 'Not enough cash'
						: submitting
							? 'Hiring…'
							: `Hire ${toHire.toLocaleString('de-DE')} worker${toHire === 1 ? '' : 's'}`}
				</button>
			{/if}
		</div>

		<div class="e-panel">
			<h3 class="e-panel__title"><Briefcase size={14} /> Chief executive</h3>

			{#if ceoHired}
				<p class="e-workers__note">
					A chief executive is running this airline. They buy aircraft, open routes, set fares,
					take staff onto the payroll and send overdue airframes for their checks — and they
					settle any accident claim out of court rather than waiting for you to fight it.
				</p>

				<div class="e-kv">
					<span class="e-kv__key">Run by</span>
					<span class="e-kv__value"><span class="e-tag e-tag--teal">Hired CEO</span></span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Your stake</span>
					<span class="e-kv__value">
						{playerShares.toLocaleString('de-DE')} of {TOTAL_SHARES.toLocaleString('de-DE')}
						· {stakePercent.toFixed(1)}%
					</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Days until the fee costs you control</span>
					<span class="e-kv__value">{daysAfforded.toLocaleString('de-DE')}</span>
				</div>

				{#if daysAfforded <= 7}
					<p class="e-workers__note e-workers__note--warning">
						Your stake is nearly down to half the register. The CEO is dismissed automatically
						when it gets there, and the airline goes to its own management.
					</p>
				{/if}

				<button
					class="e-button e-button--danger e-button--block e-workers__submit"
					type="button"
					disabled={submitting}
					onclick={confirmFireCeo}
				>
					{submitting ? 'Dismissing…' : 'Dismiss the CEO'}
				</button>
			{:else}
				<p class="e-workers__note">
					Hand the airline to a chief executive and its daily decisions become theirs: aircraft,
					routes, fares, payroll, and overdue airframes going in for their checks unasked. They
					also settle accident claims out of court instead of leaving them for you to fight.
					The fee is one of your shares a day, sold the moment they are paid.
				</p>

				<div class="e-kv">
					<span class="e-kv__key">Your stake</span>
					<span class="e-kv__value">
						{playerShares.toLocaleString('de-DE')} of {TOTAL_SHARES.toLocaleString('de-DE')}
						· {stakePercent.toFixed(1)}%
					</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Fee</span>
					<span class="e-kv__value">1 share/day</span>
				</div>
				<div class="e-kv">
					<span class="e-kv__key">Your stake covers</span>
					<span class="e-kv__value">
						{daysAfforded.toLocaleString('de-DE')} day{daysAfforded === 1 ? '' : 's'}
					</span>
				</div>

				<button
					class="e-button e-button--primary e-button--block e-workers__submit"
					type="button"
					disabled={submitting || !controlsIt}
					onclick={confirmHireCeo}
				>
					<Briefcase size={16} />
					{!controlsIt ? 'You do not control this airline' : submitting ? 'Hiring…' : 'Hire a CEO'}
				</button>
			{/if}
		</div>
	</div>
{/if}

<style lang="scss">
	.e-workers__subtitle {
		margin: 16px 0 4px;
		color: #6b7280;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}

	.e-workers__note {
		margin-bottom: 16px;
		color: #6b7280;
		font-size: 12px;
		line-height: 1.5;

		&--warning {
			margin-top: 12px;
			color: #b45309;
			font-weight: 600;
		}
	}

	.e-workers__quick {
		display: flex;
		gap: 4px;
		margin-top: 8px;
	}

	.e-workers__submit {
		margin-top: 20px;
	}
</style>
