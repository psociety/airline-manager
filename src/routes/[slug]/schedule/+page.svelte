<script lang="ts">
	import { base } from '$lib/paths';
	import { page } from '$app/stores';
	import Countdown from '$components/Countdown.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { blockHoursSlots, getModel } from '$data/aircraft';
	import {
		addScheduleEntry,
		clearSchedule,
		companyFleet,
		companyRoutes,
		copyScheduleDay,
		removeScheduleEntry,
		scheduleForAircraft,
		scheduleOverlaps
	} from '$db/repo';
	import type { Aircraft, Company, Route, ScheduleEntry } from '$db/schema';
	import { DAY_NAMES_LONG, formatHours } from '$engine/clock';
	import { diagnoseAircraft, type AircraftDiagnosis } from '$engine/diagnostics';
	import { blockHoursExact } from '$data/aircraft';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import {
		CalendarClock,
		Clock,
		Copy as CopyIcon,
		Info,
		Plane,
		RotateCcw,
		Trash2,
		TriangleAlert
	} from 'lucide-svelte';

	const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
	const MONDAY = 0;

	/**
	 * The browser's default drag image sits directly under the cursor and hides the very
	 * cells you are aiming at. Handing the drag a 1×1 transparent pixel suppresses it, so
	 * the highlighted slot in the grid and the banner above it become the only feedback.
	 * The pixel is rendered rather than constructed on the fly: Firefox only honours a
	 * drag image that is already in the document and decoded.
	 */
	let dragGhost = $state<HTMLImageElement | null>(null);

	const suppressDragImage = (event: DragEvent): void => {
		if (!event.dataTransfer || !dragGhost) return;

		event.dataTransfer.effectAllowed = 'copy';
		event.dataTransfer.setDragImage(dragGhost, 0, 0);
	};

	const slug = $derived($page.params.slug ?? '');

	let company = $state<Company | null>(null);
	let fleet = $state<Aircraft[]>([]);
	let routes = $state<Route[]>([]);
	let selectedAircraftId = $state<number | null>(null);
	let entries = $state<ScheduleEntry[]>([]);
	let draggingRouteId = $state<number | null>(null);
	let hoverCell = $state<{ dayOfWeek: number; hour: number } | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;
			fleet = await companyFleet(found.id);
			routes = await companyRoutes(found.id);

			if (selectedAircraftId === null || !fleet.some((item) => item.id === selectedAircraftId)) {
				selectedAircraftId = fleet[0]?.id ?? null;
			}
			entries = selectedAircraftId ? await scheduleForAircraft(selectedAircraftId) : [];
		})();
	});

	const selectedAircraft = $derived(
		fleet.find((aircraft) => aircraft.id === selectedAircraftId) ?? null
	);
	const selectedModel = $derived(selectedAircraft ? getModel(selectedAircraft.modelId) : null);

	const routesById = $derived(new Map(routes.map((route) => [route.id, route])));

	/** Routes this airframe can actually fly, with the slot width each would occupy. */
	const flyableRoutes = $derived.by(() => {
		const model = selectedModel;
		if (!model) return [];
		return routes
			.filter((route) => route.distanceKm <= model.range)
			.map((route) => ({
				route,
				slots: blockHoursSlots(model, route.distanceKm),
				hours: blockHoursExact(model, route.distanceKm)
			}));
	});

	const unreachableCount = $derived(routes.length - flyableRoutes.length);

	const weeklyHours = $derived(entries.reduce((sum, entry) => sum + entry.blockHours, 0));

	const selectAircraft = async (aircraftId: number): Promise<void> => {
		selectedAircraftId = aircraftId;
		entries = await scheduleForAircraft(aircraftId);
	};

	const slotsFor = (routeId: number): number => {
		const route = routesById.get(routeId);
		if (!route || !selectedModel) return 1;
		return blockHoursSlots(selectedModel, route.distanceKm);
	};

	/** Entry occupying a cell, if any, plus whether the cell is the entry's first hour. */
	const entryAt = (dayOfWeek: number, hour: number): ScheduleEntry | null =>
		entries.find(
			(entry) =>
				entry.dayOfWeek === dayOfWeek &&
				hour >= entry.startHour &&
				hour < entry.startHour + entry.blockHours
		) ?? null;

	const dropPreview = $derived.by(() => {
		if (draggingRouteId === null || !hoverCell) return null;
		const slots = slotsFor(draggingRouteId);
		const fits = hoverCell.hour + slots <= 24;
		const clashes = scheduleOverlaps(entries, {
			dayOfWeek: hoverCell.dayOfWeek,
			startHour: hoverCell.hour,
			blockHours: slots
		});
		return { ...hoverCell, slots, valid: fits && !clashes };
	});

	const isPreviewCell = (dayOfWeek: number, hour: number): boolean => {
		const preview = dropPreview;
		if (!preview) return false;
		return (
			preview.dayOfWeek === dayOfWeek &&
			hour >= preview.hour &&
			hour < preview.hour + preview.slots
		);
	};

	const handleDrop = async (dayOfWeek: number, hour: number): Promise<void> => {
		const routeId = draggingRouteId;
		draggingRouteId = null;
		hoverCell = null;

		if (routeId === null || !company || selectedAircraftId === null) return;

		const companyId = company.id;
		const aircraftId = selectedAircraftId;
		await game.act(
			() => addScheduleEntry(companyId, aircraftId, routeId, dayOfWeek, hour),
			'Leg scheduled'
		);
		entries = await scheduleForAircraft(aircraftId);
	};

	const removeEntry = async (entryId: number): Promise<void> => {
		await game.act(() => removeScheduleEntry(entryId), 'Leg removed');
		if (selectedAircraftId !== null) entries = await scheduleForAircraft(selectedAircraftId);
	};

	const mondayLegs = $derived(entries.filter((entry) => entry.dayOfWeek === MONDAY).length);

	let diagnosis = $state<AircraftDiagnosis | null>(null);

	$effect(() => {
		const aircraftId = selectedAircraftId;
		void entries;
		void game.revision;

		if (aircraftId === null) {
			diagnosis = null;
			return;
		}
		void diagnoseAircraft(aircraftId).then((result) => {
			diagnosis = result;
		});
	});

	const copyMonday = async (): Promise<void> => {
		if (selectedAircraftId === null || mondayLegs === 0) return;
		if (
			entries.length > mondayLegs &&
			!confirm('Replace Tuesday to Sunday with Monday’s rotation?')
		) {
			return;
		}

		busy = true;
		const aircraftId = selectedAircraftId;
		const copied = await game.act(
			() => copyScheduleDay(aircraftId, MONDAY),
			`Monday repeated across the week — ${mondayLegs * 6} legs added`
		);

		if (copied !== null) entries = await scheduleForAircraft(aircraftId);
		busy = false;
	};

	const resetSchedule = async (): Promise<void> => {
		if (selectedAircraftId === null || entries.length === 0) return;
		if (!confirm(`Clear all ${entries.length} legs from this aircraft's week?`)) return;

		busy = true;
		const aircraftId = selectedAircraftId;
		const cleared = await game.act(() => clearSchedule(aircraftId), 'Schedule cleared');

		if (cleared !== null) entries = await scheduleForAircraft(aircraftId);
		busy = false;
	};

	/**
	 * A route is flown in whichever direction the aircraft is sitting, so a leg only
	 * works if the aircraft is at one of its two ends. This walks the week and warns
	 * about legs the simulation would have to skip.
	 */
	const continuityWarnings = $derived.by(() => {
		if (!selectedAircraft) return [];
		const warnings: string[] = [];
		const ordered = [...entries].sort(
			(left, right) => left.dayOfWeek - right.dayOfWeek || left.startHour - right.startHour
		);

		let position = selectedAircraft.currentIata;
		for (const entry of ordered) {
			const route = routesById.get(entry.routeId);
			if (!route) continue;

			if (route.fromIata !== position && route.toIata !== position) {
				warnings.push(
					`${DAY_NAMES_LONG[entry.dayOfWeek]} ${String(entry.startHour).padStart(2, '0')}:00 — ${route.fromIata}/${route.toIata} does not touch ${position}, where the aircraft will be`
				);
				continue;
			}

			position = route.fromIata === position ? route.toIata : route.fromIata;
		}
		return warnings;
	});

	/** Which way round each scheduled leg will actually be flown. */
	const legDirections = $derived.by(() => {
		const directions = new Map<number, string>();
		if (!selectedAircraft) return directions;

		const ordered = [...entries].sort(
			(left, right) => left.dayOfWeek - right.dayOfWeek || left.startHour - right.startHour
		);

		let position = selectedAircraft.currentIata;
		for (const entry of ordered) {
			const route = routesById.get(entry.routeId);
			if (!route) continue;

			if (route.fromIata !== position && route.toIata !== position) {
				// Unflyable from where the aircraft will be: show the link, not a direction.
				directions.set(entry.id, `${route.fromIata}/${route.toIata}`);
				continue;
			}

			const arrival = route.fromIata === position ? route.toIata : route.fromIata;
			directions.set(entry.id, `${position}\u2192${arrival}`);
			position = arrival;
		}
		return directions;
	});
</script>

<!-- The transparent pixel that replaces the browser's drag image. -->
<img
	class="e-scheduler__ghost"
	bind:this={dragGhost}
	src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
	alt=""
	aria-hidden="true"
/>

<PageHeader title="SCHEDULING" subtitle="Drag a route onto the week to fly it">
	{#snippet stats()}
		<StatBox icon={Clock} value="{weeklyHours} h" label="Scheduled per week" />
		<StatBox icon={Plane} value={String(entries.length)} label="Legs per week" />
	{/snippet}
</PageHeader>

{#if fleet.length === 0}
	<div class="e-panel e-empty">
		<div class="e-empty__title">No aircraft</div>
		<p>Buy an aircraft before building a timetable.</p>
		<p><a class="e-button" href={`${base}/${slug}/fleet/market`}>Aircraft market</a></p>
	</div>
{:else}
	<div class="e-scheduler">
		<aside class="e-scheduler__side">
			<div class="e-panel e-panel--flush">
				<div class="e-scheduler__side-title">Aircraft</div>
				{#each fleet as aircraft (aircraft.id)}
					{@const model = getModel(aircraft.modelId)}
					<button
						class="e-scheduler__aircraft"
						class:e-scheduler__aircraft--active={aircraft.id === selectedAircraftId}
						type="button"
						onclick={() => selectAircraft(aircraft.id)}
					>
						<span class="e-scheduler__aircraft-name">{aircraft.name}</span>
						<span class="e-scheduler__aircraft-meta">
							{model.name} · {aircraft.currentIata} · {aircraft.status}
						</span>
					</button>
				{/each}
			</div>

			<div class="e-panel e-panel--flush e-scheduler__routes">
				<div class="e-scheduler__side-title">
					Routes {#if unreachableCount > 0}
						<span class="e-tag e-tag--yellow">{unreachableCount} out of range</span>
					{/if}
				</div>

				{#if routes.length === 0}
					<p class="e-scheduler__note">
						No routes yet. <a href={`${base}/${slug}/routes`}>Set one up</a> first.
					</p>
				{:else}
					{#each flyableRoutes as item (item.route.id)}
						<div
							class="e-scheduler__chip"
							class:e-scheduler__chip--dragging={draggingRouteId === item.route.id}
							draggable="true"
							role="button"
							tabindex="0"
							ondragstart={(event) => {
								draggingRouteId = item.route.id;
								suppressDragImage(event);
							}}
							ondragend={() => {
								draggingRouteId = null;
								hoverCell = null;
							}}
						>
							<span class="e-scheduler__chip-route">
								{item.route.fromIata} ⇄ {item.route.toIata}
							</span>
							<span class="e-scheduler__chip-meta">
								{formatHours(item.hours)} · {item.slots} slot{item.slots === 1 ? '' : 's'}
							</span>
						</div>
					{/each}
				{/if}
			</div>
		</aside>

		<div class="e-panel e-scheduler__grid-panel">
			<h3 class="e-panel__title">
				<CalendarClock size={14} />
				{selectedAircraft?.name ?? 'Select an aircraft'}
				{#if selectedModel}
					<span class="e-scheduler__model">{selectedModel.name}</span>
				{/if}
			</h3>

			<div class="e-scheduler__toolbar">
				<button
					class="e-button e-button--small"
					type="button"
					disabled={mondayLegs === 0 || busy}
					title={mondayLegs === 0
						? 'Build a Monday first, then repeat it across the week'
						: 'Replace Tuesday to Sunday with Monday’s rotation'}
					onclick={copyMonday}
				>
					<CopyIcon size={12} /> Copy Monday to the rest of the week
				</button>
				<button
					class="e-button e-button--small"
					type="button"
					disabled={entries.length === 0 || busy}
					onclick={resetSchedule}
				>
					<RotateCcw size={12} /> Reset schedule
				</button>
			</div>

		{#if draggingRouteId !== null && !dropPreview}
				<div class="e-scheduler__dropbar">
					<strong>Carrying the leg</strong>
					<span>Move over an hour in the grid to place it.</span>
				</div>
			{/if}

			{#if dropPreview}
				{@const target = routesById.get(draggingRouteId ?? -1)}
				<div
					class="e-scheduler__dropbar"
					class:e-scheduler__dropbar--invalid={!dropPreview.valid}
				>
					<strong>
						{target ? `${target.fromIata} ⇄ ${target.toIata}` : 'Leg'}
					</strong>
					<span>
						{DAY_NAMES_LONG[dropPreview.dayOfWeek]}
						{String(dropPreview.hour).padStart(2, '0')}:00 –
						{String(dropPreview.hour + dropPreview.slots).padStart(2, '0')}:00
						({dropPreview.slots} h)
					</span>
					<span class="e-scheduler__dropbar-verdict">
						{dropPreview.valid
							? 'Release to schedule'
							: dropPreview.hour + dropPreview.slots > 24
								? 'Does not fit before midnight'
								: 'Overlaps another leg'}
					</span>
				</div>
			{/if}

			<div class="e-scheduler__grid-wrapper">
				<table class="e-scheduler__grid">
					<thead>
						<tr>
							<th class="e-scheduler__day-head"></th>
							{#each HOURS as hour (hour)}
								<th class="e-scheduler__hour-head">{hour}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each DAY_NAMES_LONG as dayName, dayOfWeek (dayName)}
							<tr>
								<th class="e-scheduler__day-head">{dayName.slice(0, 3)}</th>
								{#each HOURS as hour (hour)}
									{@const entry = entryAt(dayOfWeek, hour)}
									{#if entry && entry.startHour === hour}
										{@const route = routesById.get(entry.routeId)}
									<td
											class="e-scheduler__cell"
											class:e-scheduler__cell--invalid={isPreviewCell(dayOfWeek, hour)}
											colspan={entry.blockHours}
											ondragover={(event) => {
												event.preventDefault();
												hoverCell = { dayOfWeek, hour };
											}}
										>
											<button
												class="e-scheduler__leg"
												type="button"
												title="Remove this leg"
												onclick={() => removeEntry(entry.id)}
											>
												<span class="e-scheduler__leg-label">
													{legDirections.get(entry.id) ??
														(route ? `${route.fromIata}\u2013${route.toIata}` : 'route')}
												</span>
												<Trash2 size={10} />
											</button>
										</td>
									{:else if entry}
										<!-- covered by the colspan of the leg that starts earlier -->
									{:else}
										<td
											class="e-scheduler__cell"
											class:e-scheduler__cell--preview={isPreviewCell(dayOfWeek, hour) &&
												dropPreview?.valid}
											class:e-scheduler__cell--invalid={isPreviewCell(dayOfWeek, hour) &&
												!dropPreview?.valid}
											ondragover={(event) => {
												event.preventDefault();
												hoverCell = { dayOfWeek, hour };
											}}
											ondrop={(event) => {
												event.preventDefault();
												void handleDrop(dayOfWeek, hour);
											}}
										></td>
									{/if}
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<p class="e-scheduler__note">
				A leg is as wide as it takes: a 4-hour route dropped on column 2 fills 2, 3, 4 and 5. Click
				a leg to remove it. Routes are flown in both directions, so consecutive legs on the same
				route alternate out and back on their own.
			</p>

			{#if diagnosis}
				<div
					class="e-scheduler__status"
					class:e-scheduler__status--problem={diagnosis.flyableCount === 0 && entries.length > 0}
				>
					<strong>
						{#if diagnosis.flyableCount === 0 && entries.length > 0}
							<TriangleAlert size={12} /> This aircraft will not fly anything
						{:else}
							<Info size={12} /> {diagnosis.flyableCount} of {entries.length} legs will fly
						{/if}
					</strong>
					<span>
						Currently at <strong>{diagnosis.currentIata}</strong>, status {diagnosis.status}.
						{#if diagnosis.summary}{diagnosis.summary}{/if}
					</span>
					{#if diagnosis.nextDepartureAt !== null}
						<span>
							Next departure in <Countdown until={diagnosis.nextDepartureAt} doneLabel="moments" />.
						</span>
					{/if}
				</div>
			{/if}

			{#if continuityWarnings.length > 0}
				<div class="e-scheduler__warning">
					<strong><TriangleAlert size={12} /> Legs that will be skipped</strong>
					<ul>
						{#each continuityWarnings as warning (warning)}
							<li>{warning}</li>
						{/each}
					</ul>
					<span>
						An aircraft can only depart from where it currently is, so these legs will be skipped.
						Chain routes so each one touches the airport the previous leg landed at.
					</span>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style lang="scss">
	.e-scheduler {
		display: grid;
		grid-template-columns: 240px 1fr;
		gap: 20px;
		align-items: start;

		&__side {
			display: flex;
			flex-direction: column;
			gap: 20px;
		}

		&__side-title {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 6px;
			padding: 12px 14px;
			color: #6b7280;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.5px;
			text-transform: uppercase;
			border-bottom: 1px solid #e5e7eb;
		}

		&__aircraft {
			display: flex;
			flex-direction: column;
			gap: 2px;
			width: 100%;
			padding: 10px 14px;
			text-align: left;
			background: none;
			border: none;
			border-bottom: 1px solid #f1f2f5;
			cursor: pointer;

			&:hover {
				background: #f8f9fb;
			}

			&--active {
				background: rgba(0, 208, 156, 0.12);
			}
		}

		&__aircraft-name {
			font-size: 12px;
			font-weight: 600;
		}

		&__aircraft-meta {
			color: #6b7280;
			font-size: 10px;
		}

		&__routes {
			max-height: 320px;
			overflow-y: auto;
		}

		&__chip {
			display: flex;
			flex-direction: column;
			gap: 2px;
			margin: 8px 10px;
			padding: 8px 10px;
			background: #ffffff;
			border: 1px solid #e5e7eb;
			border-left: 3px solid var(--accent-teal);
			border-radius: 6px;
			cursor: grab;

			&:active {
				cursor: grabbing;
			}
		}

		&__chip--dragging {
			opacity: 0.45;
			border-left-color: #6b7280;
		}

		&__ghost {
			position: fixed;
			top: 0;
			left: 0;
			width: 1px;
			height: 1px;
			opacity: 0;
			pointer-events: none;
		}

		&__chip-route {
			font-size: 12px;
			font-weight: 700;
		}

		&__chip-meta {
			color: #6b7280;
			font-size: 10px;
		}

		&__grid-panel {
			overflow: hidden;
		}

		&__toolbar {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			margin-bottom: 12px;
		}

		&__model {
			margin-left: auto;
			color: #6b7280;
			font-size: 11px;
			font-weight: 400;
		}

		&__dropbar {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 10px;
			margin-bottom: 8px;
			padding: 8px 12px;
			color: #04231b;
			font-size: 12px;
			background: rgba(0, 208, 156, 0.2);
			border-radius: 6px;

			span {
				color: #1c1d21;
			}

			&--invalid {
				color: #7f1d1d;
				background: rgba(255, 59, 48, 0.16);

				span {
					color: #7f1d1d;
				}
			}
		}

		&__dropbar-verdict {
			margin-left: auto;
			font-weight: 700;
		}

		&__grid-wrapper {
			overflow-x: auto;
		}

		&__grid {
			width: 100%;
			border-collapse: collapse;
			table-layout: fixed;
		}

		&__hour-head {
			width: 3.6%;
			padding: 4px 0;
			color: #6b7280;
			font-size: 9px;
			font-weight: 700;
			text-align: center;
		}

		&__day-head {
			width: 40px;
			padding: 4px 6px;
			color: #6b7280;
			font-size: 10px;
			font-weight: 700;
			text-align: left;
			text-transform: uppercase;
		}

		&__cell {
			height: 30px;
			padding: 1px;
			background: #f8f9fb;
			border: 1px solid #eef0f4;

			&--preview {
				background: rgba(0, 208, 156, 0.45);
				box-shadow: inset 0 0 0 1px rgba(0, 208, 156, 0.9);
			}

			&--invalid {
				background: rgba(255, 59, 48, 0.35);
				box-shadow: inset 0 0 0 1px rgba(255, 59, 48, 0.8);
			}
		}

		&__leg {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 4px;
			width: 100%;
			height: 26px;
			padding: 0 6px;
			overflow: hidden;
			color: #04231b;
			font-size: 10px;
			font-weight: 700;
			white-space: nowrap;
			background: var(--accent-teal);
			border: none;
			border-radius: 4px;
			cursor: pointer;

			&:hover {
				background: #00b98b;
			}
		}

		&__leg-label {
			overflow: hidden;
			text-overflow: ellipsis;
		}

		&__note {
			margin-top: 12px;
			color: #6b7280;
			font-size: 11px;
			line-height: 1.5;
		}

		&__status {
			display: flex;
			flex-direction: column;
			gap: 2px;
			margin-top: 12px;
			padding: 10px 12px;
			color: #04231b;
			font-size: 11px;
			line-height: 1.5;
			background: rgba(0, 208, 156, 0.14);
			border-radius: 6px;

			strong {
				display: flex;
				align-items: center;
				gap: 4px;
			}

			&--problem {
				color: #7f1d1d;
				background: rgba(255, 59, 48, 0.12);
			}
		}

		&__warning {
			margin-top: 12px;
			padding: 10px 12px;
			color: #78350f;
			font-size: 11px;
			background: rgba(255, 204, 0, 0.18);
			border-radius: 6px;

			strong {
				display: flex;
				align-items: center;
				gap: 4px;
				margin-bottom: 4px;
			}

			ul {
				margin: 4px 0 6px 16px;
			}
		}
	}
</style>
