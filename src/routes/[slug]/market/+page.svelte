<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import Modal from '$components/Modal.svelte';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { getAirport } from '$data/airports';
	import {
		buyListedShares,
		cancelListing,
		companyValuation,
		listSharesForSale,
		sharesHeldBy
	} from '$db/repo';
	import {
		CONTROL_THRESHOLD,
		PLAYER_HOLDER_ID,
		TOTAL_SHARES,
		db,
		type Company,
		type ShareListing
	} from '$db/schema';
	import { formatCompactMoney } from '$engine/economy';
	import { fillOrder } from '$engine/market';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import {
		ArrowDown,
		ArrowUp,
		BadgeEuro,
		Building2,
		ChevronRight,
		ChevronsUpDown,
		Crown,
		PieChart,
		TrendingUp
	} from 'lucide-svelte';

	interface MarketRow {
		company: Company;
		sharePrice: number;
		playerShares: number;
		listings: ShareListing[];
		cheapestAsk: number | null;
		sharesForSale: number;
		isMine: boolean;
	}

	/** The columns worth ordering the table by: what a share costs, and how many are going. */
	type SortKey = 'sharePrice' | 'sharesForSale';
	type SortDirection = 'asc' | 'desc';

	const DEFAULT_SORT: SortKey = 'sharePrice';
	const DEFAULT_DIRECTION: SortDirection = 'desc';

	/**
	 * Short names for the URL. The internal keys are row field names, which have no business
	 * appearing in a link somebody might paste to someone else.
	 */
	const SORT_PARAMS: Record<SortKey, string> = {
		sharePrice: 'price',
		sharesForSale: 'for-sale'
	};

	const sortKeyOf = (value: string | null): SortKey =>
		(Object.keys(SORT_PARAMS) as SortKey[]).find((key) => SORT_PARAMS[key] === value) ??
		DEFAULT_SORT;

	const slug = $derived($page.params.slug ?? '');

	/**
	 * Handed to every dossier link so the airline's page can hand it straight back on its way out.
	 * Without it, reading one airline's filing costs the player the ordering they had chosen.
	 */
	const sortQuery = $derived($page.url.search);

	let company = $state<Company | null>(null);
	let rows = $state<MarketRow[]>([]);
	/**
	 * Read straight off the URL rather than mirrored into state, so that a link opens sorted the
	 * way it says it is and there is only ever one place the order can come from. An unrecognised
	 * value falls back to the default instead of leaving the table in no order at all.
	 */
	const sortKey = $derived(sortKeyOf($page.url.searchParams.get('sort')));
	const sortDirection = $derived<SortDirection>(
		$page.url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc'
	);
	let buyingRow = $state<MarketRow | null>(null);
	let buyQuantity = $state(1);
	let sellQuantity = $state(1);
	let sellPrice = $state(0);
	let selling = $state<MarketRow | null>(null);
	let submitting = $state(false);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;

			const companies = await db.companies.toArray();
			const allListings = await db.share_listings.toArray();

			rows = await Promise.all(
				companies.map(async (candidate) => {
					const { sharePrice } = await companyValuation(candidate.id);
					const listings = allListings
						.filter((listing) => listing.companyId === candidate.id)
						.sort((left, right) => left.pricePerShare - right.pricePerShare);

					return {
						company: candidate,
						sharePrice,
						playerShares: await sharesHeldBy(candidate.id, PLAYER_HOLDER_ID),
						listings,
						cheapestAsk: listings[0]?.pricePerShare ?? null,
						sharesForSale: listings.reduce((sum, listing) => sum + listing.quantity, 0),
						isMine: candidate.id === found.id
					} satisfies MarketRow;
				})
			);
		})();
	});

	const toggleSort = async (key: SortKey): Promise<void> => {
		// A fresh column opens on the reading that answers the obvious question — the dearest
		// shares, or the biggest block going — rather than inheriting the last column's direction.
		const direction: SortDirection = sortKey === key && sortDirection === 'desc' ? 'asc' : 'desc';

		const url = new URL($page.url);
		if (key === DEFAULT_SORT && direction === DEFAULT_DIRECTION) {
			// The default needs no spelling out, so the address stays clean until the player has
			// actually chosen something other than it.
			url.searchParams.delete('sort');
			url.searchParams.delete('dir');
		} else {
			url.searchParams.set('sort', SORT_PARAMS[key]);
			url.searchParams.set('dir', direction);
		}

		// Replaced rather than pushed: re-ordering a table is not a journey the back button should
		// have to walk back through one click at a time.
		await goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	};

	/**
	 * Sorted in a derived rather than in the effect above, so that the simulation heartbeat —
	 * which reloads the rows every few seconds — cannot throw away the ordering the player chose.
	 *
	 * Ties fall back to share price and then the airline's id: with nothing on the market every
	 * carrier reports zero for sale, and without a second key that column would order thirteen
	 * airlines arbitrarily.
	 */
	const sortedRows = $derived(
		rows.toSorted((left, right) => {
			const sign = sortDirection === 'desc' ? -1 : 1;
			const primary = (left[sortKey] - right[sortKey]) * sign;

			return primary || right.sharePrice - left.sharePrice || left.company.id - right.company.id;
		})
	);

	const portfolioValue = $derived(
		rows.reduce((sum, row) => sum + row.playerShares * row.sharePrice, 0)
	);
	const controlledCount = $derived(
		rows.filter((row) => row.playerShares > CONTROL_THRESHOLD).length
	);

	// Every airline is quoted, and every row opens its dossier. It used to be that one with
	// nothing on offer had no market in its shares, so a price would have been one nobody could
	// trade at — but a takeover offer reaches holders who never listed, so there is always a
	// price at which a stake changes hands, and the airline selling nothing is exactly the one a
	// player now needs to be able to open.

	const openBuy = (row: MarketRow): void => {
		buyingRow = row;
		buyQuantity = Math.min(row.listings[0]?.quantity ?? 1, 10);
	};

	const openSell = (row: MarketRow): void => {
		selling = row;
		sellQuantity = Math.min(row.playerShares, 10);
		sellPrice = row.sharePrice;
	};

	/** Buys from the cheapest asks first, walking the book until filled. */
	const confirmBuy = async (): Promise<void> => {
		const target = buyingRow;
		const order = orderPlan;
		if (!target || !company || !order) return;

		const buyerCompanyId = company.id;
		submitting = true;

		await game.act(async () => {
			// Checked before any fill runs. Throwing part-way through used to leave the shares
			// bought and the cash gone behind an error toast saying the order had not filled.
			if (order.shortfall > 0) throw new Error('Only part of the order could be filled');

			for (const fill of order.fills) {
				await buyListedShares(fill.listingId, PLAYER_HOLDER_ID, buyerCompanyId, fill.quantity);
			}
		}, `Bought ${order.filled} ${target.company.icao} shares`);

		submitting = false;
		buyingRow = null;
	};

	const confirmSell = async (): Promise<void> => {
		if (!selling || !company) return;
		submitting = true;

		const target = selling;
		// The proceeds are banked through the airline you are playing as: you hold the shares
		// personally, but only a company has a wallet to pay into.
		const proceedsCompanyId = company.id;
		await game.act(
			() =>
				listSharesForSale(
					target.company.id,
					PLAYER_HOLDER_ID,
					sellQuantity,
					Math.round(sellPrice),
					proceedsCompanyId
				),
			`${sellQuantity} ${target.company.icao} shares listed at ${Math.round(sellPrice)} €`
		);

		submitting = false;
		selling = null;
	};

	const withdrawListing = async (listingId: number): Promise<void> => {
		await game.act(() => cancelListing(listingId), 'Listing withdrawn');
	};

	/**
	 * What the order would actually execute as. Excludes the player's own asks, which
	 * `buyListedShares` refuses — quoting them would price an order that cannot run.
	 */
	const orderPlan = $derived(
		buyingRow ? fillOrder(buyingRow.listings, buyQuantity, PLAYER_HOLDER_ID) : null
	);
	const orderTotal = $derived(orderPlan?.total ?? 0);
</script>

<PageHeader title="STOCK MARKET" subtitle="{TOTAL_SHARES.toLocaleString('de-DE')} shares per airline · above 50% gives control">
	{#snippet stats()}
		<StatBox
			icon={PieChart}
			value={formatCompactMoney(portfolioValue)}
			label="Your holdings"
		/>
		<StatBox icon={Crown} value={String(controlledCount)} label="Airlines controlled" />
	{/snippet}
</PageHeader>

<!-- Shared by the linked and the inert form of the cell, so the two cannot drift apart. -->
{#snippet airlineName(row: MarketRow)}
	<span class="e-market__dot" style:background={row.company.colour}></span>
	{row.company.icao} · {row.company.name}
{/snippet}

<!-- Both sortable columns come from here, so their behaviour and their arrow cannot diverge. -->
{#snippet sortableHeader(key: SortKey, label: string)}
	<th
		class="e-table__num"
		aria-sort={sortKey === key ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}
	>
		<button class="e-market__sort" type="button" onclick={() => toggleSort(key)}>
			{label}
			{#if sortKey !== key}
				<!-- Wrapped rather than given the class directly: a class passed into a component
				     is not scoped, so the style would be dropped as unused. -->
				<span class="e-market__sort-idle"><ChevronsUpDown size={12} /></span>
			{:else if sortDirection === 'desc'}
				<ArrowDown size={12} />
			{:else}
				<ArrowUp size={12} />
			{/if}
		</button>
	</th>
{/snippet}

<div class="e-table-wrapper">
	<table class="e-table">
		<thead>
			<tr>
				<th>Airline</th>
				<th>Hub</th>
				{@render sortableHeader('sharePrice', 'Share price')}
				<th class="e-table__num">Your stake</th>
				{@render sortableHeader('sharesForSale', 'For sale')}
				<th class="e-table__num">Cheapest ask</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each sortedRows as row (row.company.id)}
				{@const stake = (row.playerShares / TOTAL_SHARES) * 100}
				<tr class="e-market__row--linked">
					<td>
						<a
							class="e-market__name e-market__name--link"
							href={`/${slug}/market/${row.company.id}${sortQuery}`}
						>
							{@render airlineName(row)}
							<ChevronRight size={12} />
						</a>
						{#if row.isMine}
							<span class="e-tag e-tag--teal">This airline</span>
						{:else if row.playerShares > CONTROL_THRESHOLD}
							<span class="e-tag e-tag--teal">You control it</span>
						{:else if row.company.controller === 'player'}
							<span class="e-tag">Yours</span>
						{/if}
					</td>
					<td>{getAirport(row.company.homeIata).city}</td>
					<td class="e-table__num">{row.sharePrice.toLocaleString('de-DE')} €</td>
					<td class="e-table__num">
						{row.playerShares.toLocaleString('de-DE')}
						<span class="e-market__stake">{stake.toFixed(1)}%</span>
					</td>
					<td class="e-table__num">{row.sharesForSale.toLocaleString('de-DE')}</td>
					<td class="e-table__num">
						{row.cheapestAsk ? `${row.cheapestAsk.toLocaleString('de-DE')} €` : '—'}
					</td>
					<td class="e-market__actions">
						<button
							class="e-button e-button--small"
							type="button"
							disabled={row.sharesForSale === 0}
							onclick={() => openBuy(row)}
						>
							Buy
						</button>
						<button
							class="e-button e-button--small"
							type="button"
							disabled={row.playerShares === 0}
							onclick={() => openSell(row)}
						>
							Sell
						</button>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<div class="e-panel e-market__panel">
	<h3 class="e-panel__title"><TrendingUp size={14} /> Your open listings</h3>
	{#each rows as row (row.company.id)}
		{#each row.listings.filter((listing) => listing.sellerId === PLAYER_HOLDER_ID) as listing (listing.id)}
			<div class="e-kv">
				<span class="e-kv__key">
					{row.company.icao} — {listing.quantity} shares at {listing.pricePerShare.toLocaleString('de-DE')} €
				</span>
				<span class="e-kv__value">
					<button
						class="e-button e-button--small"
						type="button"
						onclick={() => withdrawListing(listing.id)}
					>
						Withdraw
					</button>
				</span>
			</div>
		{/each}
	{/each}
	{#if rows.every((row) => row.listings.every((listing) => listing.sellerId !== PLAYER_HOLDER_ID))}
		<p class="e-market__note">You have nothing on the market.</p>
	{/if}
</div>

{#if buyingRow && company}
	<!-- The player's own asks are not for sale to the player, so they are not on offer here. -->
	{@const maxAvailable = buyingRow.listings
		.filter((listing) => listing.sellerId !== PLAYER_HOLDER_ID)
		.reduce((sum, listing) => sum + listing.quantity, 0)}
	<Modal title="Buy {buyingRow.company.icao} shares" onClose={() => (buyingRow = null)}>
		<div class="e-kv">
			<span class="e-kv__key">Shares on offer</span>
			<span class="e-kv__value">{maxAvailable.toLocaleString('de-DE')}</span>
		</div>
		<div class="e-kv">
			<span class="e-kv__key">Your stake now</span>
			<span class="e-kv__value">
				{buyingRow.playerShares} / {TOTAL_SHARES}
				({((buyingRow.playerShares / TOTAL_SHARES) * 100).toFixed(1)}%)
			</span>
		</div>

		<div class="e-field">
			<label class="e-field__label" for="buy-quantity">Shares to buy</label>
			<input id="buy-quantity" type="range" min="1" max={maxAvailable} bind:value={buyQuantity} />
			<input
				class="e-market__number"
				type="number"
				min="1"
				max={maxAvailable}
				bind:value={buyQuantity}
			/>
		</div>

		<div class="e-kv">
			<span class="e-kv__key">Cost (cheapest asks first)</span>
			<span class="e-kv__value"><Money amount={orderTotal} /></span>
		</div>
		<div class="e-kv">
			<span class="e-kv__key">Stake afterwards</span>
			<span class="e-kv__value">
				{(((buyingRow.playerShares + buyQuantity) / TOTAL_SHARES) * 100).toFixed(1)}%
			</span>
		</div>

		{#if buyingRow.playerShares + buyQuantity > CONTROL_THRESHOLD && !buyingRow.isMine}
			<p class="e-market__highlight">
				<Crown size={12} /> This purchase takes you past 50% — you gain control of
				{buyingRow.company.name} and it joins your airline switcher.
			</p>
		{/if}

		{#snippet footer()}
			<button class="e-button" type="button" onclick={() => (buyingRow = null)}>Cancel</button>
			<button
				class="e-button e-button--primary"
				type="button"
				disabled={submitting || orderTotal > (company?.cash ?? 0)}
				onclick={confirmBuy}
			>
				{orderTotal > (company?.cash ?? 0) ? 'Not enough cash' : submitting ? 'Buying…' : 'Buy shares'}
			</button>
		{/snippet}
	</Modal>
{/if}

{#if selling}
	<Modal title="Sell {selling.company.icao} shares" onClose={() => (selling = null)}>
		<p class="e-market__note">
			Listed shares stay yours until somebody buys them. AI airlines pick up cheap equity when they
			are flush with cash.
		</p>

		<div class="e-field">
			<label class="e-field__label" for="sell-quantity">
				Shares to list (you hold {selling.playerShares})
			</label>
			<input
				id="sell-quantity"
				type="range"
				min="1"
				max={selling.playerShares}
				bind:value={sellQuantity}
			/>
			<input
				class="e-market__number"
				type="number"
				min="1"
				max={selling.playerShares}
				bind:value={sellQuantity}
			/>
		</div>

		<div class="e-field">
			<label class="e-field__label" for="sell-price">
				Asking price per share (market: {selling.sharePrice.toLocaleString('de-DE')} €)
			</label>
			<input id="sell-price" type="number" min="1" step="10" bind:value={sellPrice} />
		</div>

		<div class="e-kv">
			<span class="e-kv__key">Proceeds if fully sold</span>
			<span class="e-kv__value"><Money amount={sellQuantity * Math.round(sellPrice)} /></span>
		</div>

		{#if selling.isMine && selling.playerShares - sellQuantity <= CONTROL_THRESHOLD}
			<p class="e-market__highlight e-market__highlight--warning">
				<Building2 size={12} /> Selling this many drops you to or below 50% of your own airline. If
				somebody buys them you lose control of it.
			</p>
		{/if}

		{#snippet footer()}
			<button class="e-button" type="button" onclick={() => (selling = null)}>Cancel</button>
			<button
				class="e-button e-button--primary"
				type="button"
				disabled={submitting || sellQuantity < 1 || sellPrice < 1}
				onclick={confirmSell}
			>
				{submitting ? 'Listing…' : 'List shares'}
			</button>
		{/snippet}
	</Modal>
{/if}

<style lang="scss">
	.e-market {
		&__name {
			display: flex;
			align-items: center;
			gap: 6px;
			font-weight: 600;

			&--link {
				color: inherit;
				text-decoration: none;

				&:hover {
					color: #00a37c;
				}
			}
		}

		// Only airlines with shares on offer lead anywhere, so only those rows react.
		&__row--linked:hover {
			background: #fafbfc;
		}

		&__dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
		}

		&__stake {
			display: block;
			color: #6b7280;
			font-size: 10px;
		}

		&__sort {
			display: inline-flex;
			align-items: center;
			// Pushed to the right edge to sit under the figures the column holds, which are
			// right-aligned by `e-table__num`.
			justify-content: flex-end;
			gap: 4px;
			width: 100%;
			padding: 0;
			border: none;
			background: none;
			color: inherit;
			font: inherit;
			letter-spacing: inherit;
			text-transform: inherit;
			cursor: pointer;

			&:hover {
				color: #111827;
			}
		}

		// Only a hint that the column can be sorted, so it must not read as the current order.
		&__sort-idle {
			display: inline-flex;
			opacity: 0.35;
		}

		&__actions {
			display: flex;
			gap: 4px;
		}

		&__panel {
			margin-top: 20px;
		}

		&__note {
			color: #6b7280;
			font-size: 11px;
			line-height: 1.5;
		}

		&__number {
			margin-top: 6px;
			text-align: right;
		}

		&__highlight {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-top: 12px;
			padding: 8px 10px;
			color: #04231b;
			font-size: 11px;
			font-weight: 600;
			background: rgba(0, 208, 156, 0.18);
			border-radius: 6px;

			&--warning {
				color: #78350f;
				background: rgba(255, 204, 0, 0.22);
			}
		}
	}
</style>
