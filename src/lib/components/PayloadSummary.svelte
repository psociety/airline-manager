<script lang="ts">
	import type { AircraftModelDerived } from '$data/types';
	import { Package, Weight } from 'lucide-svelte';

	interface PayloadSummaryProps {
		model: AircraftModelDerived;
	}

	const { model }: PayloadSummaryProps = $props();
</script>

<div class="e-payload">
	<div class="e-payload__headline">
		<Package size={16} />
		<strong>{model.payload.toLocaleString('de-DE')} t</strong>
		<span>of freight capacity</span>
	</div>

	<p class="e-payload__note">
		A freighter has no cabin to lay out — its hold is fixed. It earns per tonne carried at
		the rate you set on each route, drawn from the freight demand of the airports it links.
	</p>

	<div class="e-kv">
		<span class="e-kv__key"><Weight size={12} /> Crew and ground staff</span>
		<span class="e-kv__value">{model.employees}</span>
	</div>
	<div class="e-kv">
		<span class="e-kv__key">Fuel burn is sized on</span>
		<span class="e-kv__value">{model.capacityUnits.toLocaleString('de-DE')} capacity units</span>
	</div>
</div>

<style lang="scss">
	.e-payload {
		&__headline {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-bottom: 8px;
			font-size: 13px;

			strong {
				font-size: 18px;
			}

			span {
				color: #6b7280;
			}
		}

		&__note {
			margin-bottom: 12px;
			color: #6b7280;
			font-size: 11px;
			line-height: 1.5;
		}
	}
</style>
