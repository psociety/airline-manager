<script lang="ts">
	import { getModel } from '$data/aircraft';
	import { getAirport } from '$data/airports';
	import {
		AircraftSprite,
		spriteForModel,
		spriteOffset,
		spriteSheetSize
	} from '$data/aircraft_sprites';
	import type { Aircraft, Flight, Route } from '$db/schema';
	import { bearing, greatCirclePoints, interpolate } from '$engine/geo';
	import { game } from '$state/game.svelte';
	import { onMount } from 'svelte';
	import type { Map as LeafletMap, LayerGroup, Marker, Polyline } from 'leaflet';

	interface RouteMapProps {
		routes: Route[];
		flights: Flight[];
		colour: string;
		/** The company's aircraft, so each flight can be drawn with its type's icon. */
		fleet?: Aircraft[];
		/** Routes flown by other airlines, drawn faintly for context. */
		rivalRoutes?: Route[];
	}

	const { routes, flights, colour, fleet = [], rivalRoutes = [] }: RouteMapProps = $props();

	/**
	 * Marker size in pixels. Half of the spritesheet's 100px cell, so the icons scale
	 * exactly and stay crisp. The stylesheet reads it back as a custom property, which
	 * keeps this the only place the size is written down.
	 */
	const PLANE_ICON_SIZE = 50;

	const fleetById = $derived(new Map(fleet.map((aircraft) => [aircraft.id, aircraft])));

	/** The spritesheet cell and type name for a flight, defaulting to a twin jet. */
	const iconFor = (
		flight: Flight
	): { offset: { x: number; y: number }; modelName: string | null } => {
		const aircraft = fleetById.get(flight.aircraftId);
		const model = aircraft ? getModel(aircraft.modelId) : null;
		const sprite = model ? spriteForModel(model) : AircraftSprite.TwinEngine;

		return { offset: spriteOffset(sprite, PLANE_ICON_SIZE), modelName: model?.name ?? null };
	};

	let container: HTMLDivElement;
	let map = $state<LeafletMap | null>(null);
	let leaflet = $state<typeof import('leaflet') | null>(null);
	let routeLayer = $state<LayerGroup | null>(null);
	let aircraftLayer = $state<LayerGroup | null>(null);
	const markers = new Map<number, Marker>();

	onMount(() => {
		let disposed = false;

		void (async () => {
			// Leaflet touches `window` on import, so it can only load in the browser.
			const module = await import('leaflet');
			await import('leaflet/dist/leaflet.css');
			if (disposed) return;

			leaflet = module;
			const instance = module.map(container, {
				center: [30, 0],
				zoom: 2,
				minZoom: 2,
				worldCopyJump: true,
				attributionControl: false
			});

			module
				.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
					subdomains: 'abcd',
					maxZoom: 10
				})
				.addTo(instance);

			routeLayer = module.layerGroup().addTo(instance);
			aircraftLayer = module.layerGroup().addTo(instance);
			map = instance;
		})();

		return () => {
			disposed = true;
			markers.clear();
			map?.remove();
			map = null;
		};
	});

	/** Redraw the network whenever the route list changes. */
	$effect(() => {
		const module = leaflet;
		const layer = routeLayer;
		const instance = map;
		if (!module || !layer || !instance) return;

		layer.clearLayers();
		const airportsSeen = new Map<string, [number, number]>();

		for (const route of rivalRoutes) {
			const from = getAirport(route.fromIata);
			const to = getAirport(route.toIata);
			module
				.polyline(greatCirclePoints(from, to), {
					color: '#9aa1ae',
					weight: 1,
					opacity: 0.28,
					dashArray: '3 5'
				})
				.addTo(layer);
		}

		for (const route of routes) {
			const from = getAirport(route.fromIata);
			const to = getAirport(route.toIata);
			airportsSeen.set(route.fromIata, [from.latitude, from.longitude]);
			airportsSeen.set(route.toIata, [to.latitude, to.longitude]);

			const line: Polyline = module.polyline(greatCirclePoints(from, to), {
				color: colour,
				weight: 2,
				opacity: 0.85
			});
			line.bindTooltip(
				`${route.fromIata} → ${route.toIata} · ${route.distanceKm.toLocaleString('de-DE')} km`
			);
			line.addTo(layer);
		}

		for (const [iata, position] of airportsSeen) {
			const airport = getAirport(iata);
			module
				.circleMarker(position, {
					radius: 4,
					color: '#202530',
					weight: 1,
					fillColor: '#ffffff',
					fillOpacity: 1
				})
				.bindTooltip(`${iata} — ${airport.city}`)
				.addTo(layer);
		}

		if (airportsSeen.size > 0) {
			instance.fitBounds(module.latLngBounds([...airportsSeen.values()]).pad(0.2), {
				maxZoom: 6,
				animate: false
			});
		}
	});

	/**
	 * Slide each airborne aircraft along its great circle. Driven by the store's
	 * one-second clock, so markers creep forward in real time.
	 */
	$effect(() => {
		const module = leaflet;
		const layer = aircraftLayer;
		if (!module || !layer) return;

		const now = game.now;
		const liveIds = new Set<number>();

		for (const flight of flights) {
			const duration = flight.arriveAt - flight.departAt;
			if (duration <= 0) continue;

			const progress = Math.max(0, Math.min(1, (now - flight.departAt) / duration));
			const from = getAirport(flight.fromIata);
			const to = getAirport(flight.toIata);
			const position = interpolate(from, to, progress);
			const heading = bearing(interpolate(from, to, Math.max(0, progress - 0.01)), to);
			liveIds.add(flight.id);

			const existing = markers.get(flight.id);
			if (existing) {
				existing.setLatLng([position.latitude, position.longitude]);
				const element = existing.getElement()?.querySelector('.e-plane-marker__icon');
				if (element instanceof HTMLElement) {
					element.style.transform = `rotate(${heading}deg)`;
				}
				continue;
			}

			const { offset, modelName } = iconFor(flight);
			const marker = module
				.marker([position.latitude, position.longitude], {
					icon: module.divIcon({
						className: 'e-plane-marker',
						iconSize: [PLANE_ICON_SIZE, PLANE_ICON_SIZE],
						iconAnchor: [Math.round(PLANE_ICON_SIZE / 2), Math.round(PLANE_ICON_SIZE / 2)],
						html: `<div class="e-plane-marker__icon" style="--plane-icon-size: ${PLANE_ICON_SIZE}px; --plane-sheet-size: ${spriteSheetSize(PLANE_ICON_SIZE)}px; transform: rotate(${heading}deg); background-position: ${offset.x}px ${offset.y}px"></div>`
					})
				})
				.bindTooltip(
					modelName
						? `${flight.fromIata} → ${flight.toIata} · ${modelName}`
						: `${flight.fromIata} → ${flight.toIata}`
				)
				.addTo(layer);

			markers.set(flight.id, marker);
		}

		for (const [flightId, marker] of markers) {
			if (liveIds.has(flightId)) continue;
			layer.removeLayer(marker);
			markers.delete(flightId);
		}
	});
</script>

<div class="e-map" bind:this={container}></div>

<style lang="scss">
	.e-map {
		width: 100%;
		height: 460px;
		background: #eef0f4;
		border: 1px solid #eef0f4;
		border-radius: 12px;
	}

	:global(.e-plane-marker__icon) {
		width: var(--plane-icon-size);
		height: var(--plane-icon-size);
		/* One cell of the 3x3 sheet, scaled from its 100px source. */
		background-image: url('/icons/airplanes.png');
		background-repeat: no-repeat;
		background-size: var(--plane-sheet-size) var(--plane-sheet-size);
		/* Keeps the yellow airframe legible over the pale basemap. */
		filter: drop-shadow(0 0 2px rgba(255, 255, 255, 0.95));
		transition: transform 0.4s linear;
	}

	:global(.leaflet-container) {
		font-family: inherit;
		border-radius: 12px;
	}
</style>
