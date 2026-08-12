<script lang="ts">
	import { base } from '$lib/paths';
	import { page } from '$app/stores';
	import CompanySwitcher from '$components/CompanySwitcher.svelte';
	import Countdown from '$components/Countdown.svelte';
	import { companyGateCount } from '$db/repo';
	import { db, type Company } from '$db/schema';
	import { formatCompactMoney } from '$engine/economy';
	import { pendingDeliveries } from '$engine/tick';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import type { Snippet } from 'svelte';
	import {
		AlertTriangle,
		BadgeEuro,
		CalendarClock,
		DoorOpen,
		FastForward,
		Home,
		Landmark,
		Plane,
		Route as RouteIcon,
		Users
	} from 'lucide-svelte';

	const { children }: { children: Snippet } = $props();

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let notFound = $state(false);
	let counters = $state({ fleet: 0, routes: 0, gates: 0, incidents: 0 });
	let deliveries = $state<{ id: number; name: string; deliveryAt: number }[]>([]);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) {
				notFound = true;
				company = null;
				return;
			}

			notFound = false;
			company = found;
			counters = {
				fleet: await db.aircraft.where('companyId').equals(found.id).count(),
				routes: await db.routes.where('companyId').equals(found.id).count(),
				gates: await companyGateCount(found.id),
				incidents: await db.incidents
					.where('[companyId+status]')
					.equals([found.id, 'pending'])
					.count()
			};
			deliveries = (await pendingDeliveries(found.id)).map((aircraft) => ({
				id: aircraft.id,
				name: aircraft.name,
				deliveryAt: aircraft.deliveryAt
			}));
		})();
	});

	const workers = $derived(
		company ? company.external_workers + company.hired_workers : 0
	);

	const navigation = $derived([
		{ href: '', label: 'Dashboard', icon: Home, count: 0 },
		{ href: '/fleet', label: 'Fleet', icon: Plane, count: counters.fleet },
		{ href: '/gates', label: 'Gates', icon: DoorOpen, count: counters.gates },
		{ href: '/routes', label: 'Routes', icon: RouteIcon, count: counters.routes },
		{ href: '/schedule', label: 'Scheduling', icon: CalendarClock, count: 0 },
		{ href: '/workers', label: 'Workers', icon: Users, count: workers },
		{ href: '/accounting', label: 'Accounting', icon: Landmark, count: 0 },
		{ href: '/market', label: 'Stock market', icon: BadgeEuro, count: 0 },
		{ href: '/incidents', label: 'Incidents', icon: AlertTriangle, count: counters.incidents }
	]);

	const isActive = (href: string): boolean => {
		const companyRoot = `${base}/${slug}`;
		if (href === '') return $page.url.pathname === companyRoot || $page.url.pathname === `${companyRoot}/`;
		return $page.url.pathname.startsWith(`${companyRoot}${href}`);
	};

	const fastForward = async (hours: number): Promise<void> => {
		const summary = await game.fastForward(hours);
		game.toast(
			`+${hours}h simulated — ${summary.flightsFlown} flights, ${summary.daysProcessed} day(s) closed`
		);
	};
</script>

{#if notFound}
	<div class="e-app-body">
		<main class="e-main-content">
			<div class="e-panel e-empty">
				<div class="e-empty__title">No such airline</div>
				<p>The slug “{slug}” does not match any airline you control.</p>
				<p><a class="e-button" href="{base}/">Back to your airlines</a></p>
			</div>
		</main>
	</div>
{:else if company}
	<div class="e-app-body">
		<aside class="e-sidebar">
			<div>
				<div class="e-sidebar__header">
					<CompanySwitcher {company} />
				</div>
				<nav>
					<ul class="e-nav-list">
						{#each navigation as item (item.href)}
							<li class="e-nav-list__item" class:e-nav-list__item--active={isActive(item.href)}>
								<a href={`${base}/${slug}${item.href}`}>
									<item.icon size={18} />
									{item.label}
									{#if item.count > 0}
										<span class="e-nav-list__count">{item.count}</span>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				</nav>
			</div>

			<div class="e-sidebar__footer">
				<div class="e-sidebar-cash">
					<span class="e-sidebar-cash__label">Cash</span>
					<strong class="e-sidebar-cash__value">{formatCompactMoney(company.cash)}</strong>
				</div>

				{#if deliveries.length > 0}
					<div class="e-sidebar-deliveries">
						<span class="e-sidebar-cash__label">Incoming aircraft</span>
						{#each deliveries as delivery (delivery.id)}
							<div class="e-sidebar-deliveries__row">
								<span>{delivery.name}</span>
								<Countdown until={delivery.deliveryAt} doneLabel="landing" />
							</div>
						{/each}
					</div>
				{/if}

				<div class="e-sidebar-dev">
					<span class="e-sidebar-cash__label">Simulate time</span>
					<div class="e-sidebar-dev__row">
						<button class="e-button e-button--small" type="button" onclick={() => fastForward(6)}>
							<FastForward size={12} /> 6h
						</button>
						<button class="e-button e-button--small" type="button" onclick={() => fastForward(24)}>
							<FastForward size={12} /> 1d
						</button>
						<button class="e-button e-button--small" type="button" onclick={() => fastForward(168)}>
							<FastForward size={12} /> 1w
						</button>
					</div>
				</div>
			</div>
		</aside>

		<main class="e-main-content">
			{@render children()}
		</main>
	</div>
{:else}
	<div class="e-app-body">
		<main class="e-main-content"><div class="e-empty">Loading airline…</div></main>
	</div>
{/if}

<style lang="scss">
	.e-sidebar-cash {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 12px;

		&__label {
			color: #6b7280;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.5px;
			text-transform: uppercase;
		}

		&__value {
			font-size: 14px;
			font-variant-numeric: tabular-nums;
		}
	}

	.e-sidebar-deliveries {
		margin-bottom: 12px;

		&__row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			margin-top: 4px;
			font-size: 11px;
		}
	}

	.e-sidebar-dev__row {
		display: flex;
		gap: 4px;
		margin-top: 4px;
	}
</style>
