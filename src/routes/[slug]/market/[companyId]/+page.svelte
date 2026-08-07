<script lang="ts">
	import { page } from '$app/stores';
	import Money from '$components/Money.svelte';
	import PageHeader from '$components/PageHeader.svelte';
	import StatBox from '$components/StatBox.svelte';
	import { getAirport } from '$data/airports';
	import { buyListedShares, openTakeoverBid } from '$db/repo';
	import { CONTROL_THRESHOLD, PLAYER_HOLDER_ID, TOTAL_SHARES, type Company } from '$db/schema';
	import { dayIndexOf, dayKey, gameNow } from '$engine/clock';
	import { formatCompactMoney, formatMoney } from '$engine/economy';
	import { CATEGORY_LABELS, GROUP_LABELS } from '$engine/ledger';
	import { companyDossier, fillOrder, type CompanyDossier } from '$engine/market';
	import {
		BID_FEE_SHARE,
		BID_WINDOW_DAYS,
		previewBid,
		quoteBid,
		refundFor,
		withdrawBid,
		type BidContext,
		type BidPreview
	} from '$engine/takeover';
	import { loadCompany } from '$state/company.svelte';
	import { game } from '$state/game.svelte';
	import {
		AlertTriangle,
		ArrowLeft,
		Coins,
		Crown,
		Landmark,
		PieChart,
		Scale,
		Swords,
		Users
	} from 'lucide-svelte';

	const BASE_CLASS = 'e-dossier';

	const slug = $derived($page.params.slug ?? '');
	const targetId = $derived(Number($page.params.companyId));

	/**
	 * The market list forwards its ordering in the query string, and every way back out of here
	 * carries it along — so reading a filing costs the player nothing about how they had the table
	 * arranged. Nothing on this page reads these itself; it only passes them on.
	 */
	const backToMarket = $derived(`/${slug}/market${$page.url.search}`);

	let company = $state<Company | null>(null);
	let dossier = $state<CompanyDossier | null>(null);
	let orderQuantity = $state(1);
	let submitting = $state(false);

	let bidPreview = $state<BidPreview | null>(null);
	let bidContext = $state<BidContext | null>(null);
	/** Null until the preview lands, so the field can default to the price it suggests. */
	let bidPrice = $state<number | null>(null);
	let bidShares = $state<number | null>(null);
	let bidding = $state(false);

	$effect(() => {
		if (!game.booted) return;
		void game.revision;
		const currentSlug = slug;
		const currentTargetId = targetId;

		void (async () => {
			const found = await loadCompany(currentSlug);
			if (!found) return;
			company = found;

			if (!Number.isInteger(currentTargetId)) {
				dossier = null;
				bidPreview = null;
				return;
			}

			const report = await companyDossier(currentTargetId);
			dossier = report;

			if (!report) {
				bidPreview = null;
				return;
			}

			const { preview, context } = await previewBid(
				currentTargetId,
				PLAYER_HOLDER_ID,
				report,
				found.id
			);
			bidPreview = preview;
			bidContext = context;

			// Only ever seeded, never corrected: the heartbeat bumps `game.revision` every few
			// seconds, and writing to these would wipe what the player was in the middle of typing.
			bidPrice ??= preview.suggestedPrice ?? preview.minimumPrice;
			bidShares ??= preview.sharesForControl;
		})();
	});

	const isOwnAirline = $derived(dossier?.company.id === company?.id);
	const buyable = $derived(
		dossier?.listings.filter((listing) => listing.sellerId !== PLAYER_HOLDER_ID) ?? []
	);
	const buyableShares = $derived(buyable.reduce((sum, listing) => sum + listing.quantity, 0));
	const hasOwnListing = $derived((dossier?.listings.length ?? 0) > buyable.length);

	// Clamped in a derived rather than written back into `orderQuantity`, because the
	// simulation heartbeat bumps `game.revision` every few seconds and an effect that
	// corrected the field would reset it while the player was still typing.
	const requested = $derived(Math.min(Math.max(1, orderQuantity), Math.max(1, buyableShares)));
	const plan = $derived(dossier ? fillOrder(dossier.listings, requested, PLAYER_HOLDER_ID) : null);

	const stakeAfter = $derived(
		dossier ? (dossier.viewerShares + (plan?.filled ?? 0)) / TOTAL_SHARES : 0
	);
	const wouldTakeControl = $derived(
		dossier ? dossier.viewerShares + (plan?.filled ?? 0) > CONTROL_THRESHOLD : false
	);
	const affordable = $derived((plan?.total ?? 0) <= (company?.cash ?? 0));

	const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

	/** A ratio of 1,18 reads as "+18%"; null means book value cannot anchor the comparison. */
	const premiumLabel = (ratio: number | null): string =>
		ratio === null ? '—' : `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(0)}%`;

	/** The same gap without its sign, for prose that already says which way it runs. */
	const gapLabel = (ratio: number): string => `${Math.abs((ratio - 1) * 100).toFixed(0)}%`;

	const runwayLabel = (days: number | null): string =>
		days === null ? 'No fixed costs' : `${Math.floor(days)} days`;

	/**
	 * Clamped in deriveds for the same reason the share order is: correcting the bound fields
	 * from an effect would fight the player's typing every time the heartbeat fires.
	 */
	const askedPrice = $derived(
		bidPreview ? Math.max(bidPreview.minimumPrice, Math.round(bidPrice ?? 0)) : 0
	);
	const askedShares = $derived(
		bidPreview
			? Math.min(Math.max(1, Math.round(bidShares ?? 1)), Math.max(1, bidPreview.sharesOutstanding))
			: 0
	);

	const bidQuote = $derived(
		dossier && bidContext && bidPreview && askedShares > 0
			? quoteBid(dossier, bidContext, PLAYER_HOLDER_ID, askedPrice, askedShares)
			: null
	);

	const canBid = $derived(
		bidPreview !== null && bidPreview.blockers.length === 0 && !isOwnAirline
	);
	const escrowAffordable = $derived((bidQuote?.escrow ?? 0) <= (company?.cash ?? 0));
	const daysLeft = $derived(
		bidPreview?.openBid ? Math.max(0, bidPreview.openBid.closesDay - dayIndexOf(gameNow())) : 0
	);

	const feeIfItLapses = $derived(
		bidQuote ? bidQuote.escrow - refundFor(bidQuote.escrow, 0) : 0
	);

	const launchBid = async (): Promise<void> => {
		const preview = bidPreview;
		const quote = bidQuote;
		if (!preview || !quote || !company) return;

		const bidderCompanyId = company.id;
		const targetCompanyId = preview.companyId;
		bidding = true;

		await game.act(
			async () => {
				await openTakeoverBid({
					targetCompanyId,
					bidderHolderId: PLAYER_HOLDER_ID,
					bidderCompanyId,
					pricePerShare: quote.pricePerShare,
					sharesSought: quote.sharesSought,
					closesDay: dayIndexOf(gameNow()) + BID_WINDOW_DAYS
				});
			},
			`Offered ${formatMoney(quote.pricePerShare)} a share for ${quote.sharesSought.toLocaleString('de-DE')} shares`
		);

		bidding = false;
	};

	const cancelBid = async (): Promise<void> => {
		const open = bidPreview?.openBid;
		if (!open) return;

		bidding = true;
		await game.act(async () => {
			await withdrawBid(open.id);
		}, 'Offer withdrawn');
		bidding = false;
	};

	const confirmBuy = async (): Promise<void> => {
		const target = dossier;
		const order = plan;
		if (!target || !company || !order) return;

		const buyerCompanyId = company.id;
		submitting = true;

		await game.act(async () => {
			// Checked before a single fill runs: a part-filled order that then throws would
			// leave the player holding shares they were told they had not bought.
			if (order.shortfall > 0) throw new Error('The book cannot fill that order');

			for (const fill of order.fills) {
				await buyListedShares(fill.listingId, PLAYER_HOLDER_ID, buyerCompanyId, fill.quantity);
			}
		}, `Bought ${order.filled} ${target.company.icao} shares`);

		submitting = false;
	};
</script>

{#if dossier}
	<!-- Bound as a const so the snippets below, which are closures of their own, keep the
	     narrowing from this branch. -->
	{@const report = dossier}
	{@const assets = report.assets}
	{@const pnl = report.pnl}

	<PageHeader
		title="{report.company.icao} · {report.company.name}"
		subtitle="Due diligence · {getAirport(report.company.homeIata).city} hub · {report.company
			.controller === 'ai'
			? 'independent'
			: (report.company.ceoHired ?? false)
				? 'CEO-run'
				: 'player-controlled'}"
	>
		<!-- Per-share figures run to a few thousand euro, where compact money would round
		     every one of them to the same "3k €" and hide the comparison being made. -->
		{#snippet stats()}
			<StatBox
				icon={Coins}
				value={report.cheapestAsk === null ? '—' : formatMoney(report.cheapestAsk)}
				label="Cheapest ask"
			/>
			<StatBox
				icon={Landmark}
				value={formatMoney(report.bookValuePerShare)}
				label="Book value per share"
			/>
			<StatBox
				icon={Scale}
				value={premiumLabel(report.askPremiumToBook)}
				label="Ask vs book"
			/>
			<StatBox
				icon={PieChart}
				value={formatMoney(report.valuation.sharePrice)}
				label="Quoted share price"
			/>
		{/snippet}

		{#snippet actions()}
			<a class="e-button e-button--ghost e-button--small" href={backToMarket}>
				<ArrowLeft size={14} /> Stock market
			</a>
		{/snippet}
	</PageHeader>

	<section class="e-panel {BASE_CLASS}__verdict">
		{#if isOwnAirline}
			<span class="e-tag e-tag--teal">This is your airline</span>
		{/if}
		{#if report.priceFloorBinding}
			<span class="e-tag e-tag--yellow">Price at the floor, not off book value</span>
		{/if}
		{#if report.askPremiumToBook !== null && report.askPremiumToBook < 1}
			<span class="e-tag e-tag--teal">
				Asking {gapLabel(report.askPremiumToBook)} under book
			</span>
		{:else if report.askPremiumToBook !== null}
			<span class="e-tag e-tag--red">
				Asking {gapLabel(report.askPremiumToBook)} over book
			</span>
		{/if}
		<span
			class="e-tag"
			class:e-tag--teal={pnl.operatingResult > 0}
			class:e-tag--red={pnl.operatingResult < 0}
		>
			{pnl.operatingResult >= 0 ? 'Profitable' : 'Loss-making'} over {pnl.daysCovered} days
		</span>
		{#if report.cashRunwayDays !== null && report.cashRunwayDays < 14}
			<span class="e-tag e-tag--red">Under two weeks of cash</span>
		{/if}
		{#if report.dailyLeases > 0}
			<span class="e-tag e-tag--yellow">
				Leases {formatCompactMoney(report.dailyLeases)}/day off the balance sheet
			</span>
		{/if}
		{#if report.pendingIncidentCount > 0}
			<span class="e-tag e-tag--yellow">
				{report.pendingIncidentCount} unsettled claim{report.pendingIncidentCount === 1 ? '' : 's'}
			</span>
		{/if}
		{#if report.control.alreadyInControl}
			<span class="e-tag e-tag--teal">You control this airline</span>
		{:else if report.control.attainable}
			<span class="e-tag e-tag--teal">
				Control available for {formatCompactMoney(report.control.plan.total)}
			</span>
		{/if}
		{#if report.openBid}
			{@const left = Math.max(0, report.openBid.closesDay - dayIndexOf(gameNow()))}
			<span class="e-tag e-tag--yellow">
				Offer open · closes in {left} {left === 1 ? 'day' : 'days'}
			</span>
		{:else if report.bidLockoutUntilDay !== null && report.bidLockoutUntilDay > dayIndexOf(gameNow())}
			<span class="e-tag e-tag--red">
				Board barred a fresh offer for {report.bidLockoutUntilDay - dayIndexOf(gameNow())} days
			</span>
		{/if}
	</section>

	<div class="e-grid-two {BASE_CLASS}__statements">
		<section class="e-panel">
			<h3 class="e-panel__title"><Landmark size={14} /> Assets</h3>

			<div class="e-kv">
				<span class="e-kv__key">Cash</span>
				<span class="e-kv__value"><Money amount={assets.cash} colour /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">
					Fleet at book · {assets.ownedAircraft} owned, {assets.leasedAircraft} leased
				</span>
				<span class="e-kv__value"><Money amount={assets.fleetBookValue} /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Stands</span>
				<span class="e-kv__value"><Money amount={assets.gateValue} /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Route goodwill · {assets.routeCount} routes</span>
				<span class="e-kv__value"><Money amount={assets.routeGoodwill} /></span>
			</div>
			<div class="e-kv {BASE_CLASS}__total">
				<span class="e-kv__key">Total assets</span>
				<span class="e-kv__value"><Money amount={assets.total} colour /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Book value per share</span>
				<span class="e-kv__value"><Money amount={report.bookValuePerShare} colour /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">
					Market sentiment · band {report.multiplierBand.min}–{report.multiplierBand.max}
				</span>
				<span class="e-kv__value">×{report.marketMultiplier.toFixed(2)}</span>
			</div>

			<p class="{BASE_CLASS}__note">
				Leased airframes count for nothing here — the airline does not own them, though it pays
				for them daily. Sentiment is re-rolled every night, so the quote moves without the
				airline changing at all.
			</p>
		</section>

		<section class="e-panel">
			<h3 class="e-panel__title"><Coins size={14} /> Account · last {pnl.daysCovered} days</h3>

			{#each pnl.groups.filter((group) => group.categories.length > 0) as group (group.group)}
				<div class="{BASE_CLASS}__group">{GROUP_LABELS[group.group]}</div>
				{#each group.categories as line (line.category)}
					<div class="e-kv">
						<span class="e-kv__key">{CATEGORY_LABELS[line.category]}</span>
						<span class="e-kv__value"><Money amount={line.amount} colour signed /></span>
					</div>
				{/each}
			{/each}

			{#if pnl.entryCount === 0}
				<p class="{BASE_CLASS}__note">
					Nothing has moved through the books yet. A newly founded airline has no trading history
					to judge.
				</p>
			{/if}

			<div class="e-kv {BASE_CLASS}__total">
				<span class="e-kv__key">Operating result</span>
				<span class="e-kv__value"><Money amount={pnl.operatingResult} colour signed /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Per day</span>
				<span class="e-kv__value">
					<Money amount={pnl.dailyOperatingResult} colour signed />
				</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Net cash movement</span>
				<span class="e-kv__value"><Money amount={pnl.netCashMovement} colour signed /></span>
			</div>

			<p class="{BASE_CLASS}__note">
				Aircraft, stands and routes are counted as investment, not as cost of trading — they
				bought the assets on the left. The operating result is what flying earns.
			</p>
		</section>

		<section class="e-panel">
			<h3 class="e-panel__title"><AlertTriangle size={14} /> Obligations</h3>

			<div class="e-kv">
				<span class="e-kv__key">Wages per day</span>
				<span class="e-kv__value"><Money amount={-report.dailyWages} /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Leases per day</span>
				<span class="e-kv__value"><Money amount={-report.dailyLeases} /></span>
			</div>
			<div class="e-kv {BASE_CLASS}__total">
				<span class="e-kv__key">Fixed costs per day</span>
				<span class="e-kv__value"><Money amount={-report.dailyFixedCosts} /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Cash runway</span>
				<span class="e-kv__value">{runwayLabel(report.cashRunwayDays)}</span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Lease commitment over a year</span>
				<span class="e-kv__value"><Money amount={report.annualisedLeaseExposure} /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Unsettled claims · {report.pendingIncidentCount}</span>
				<span class="e-kv__value"><Money amount={report.pendingIncidentExposure} /></span>
			</div>
			<div class="e-kv">
				<span class="e-kv__key">Fleet at resale</span>
				<span class="e-kv__value"><Money amount={assets.fleetResaleValue} /></span>
			</div>

			<p class="{BASE_CLASS}__note">
				None of these are deducted from the assets above: the quoted share price is drawn from
				assets alone, which is exactly why they are worth reading before buying.
			</p>
		</section>
	</div>

	<section class="e-panel {BASE_CLASS}__book">
		<h3 class="e-panel__title"><Users size={14} /> Shares on offer</h3>

		{#if report.listings.length === 0}
			<p class="{BASE_CLASS}__note">
				Nothing is listed right now. The statements above are still current, so it is worth
				checking back when a seller appears.
			</p>
		{:else}
			<div class="e-table-wrapper">
				<table class="e-table">
					<thead>
						<tr>
							<th>Seller</th>
							<th class="e-table__num">Shares</th>
							<th class="e-table__num">Price per share</th>
							<th class="e-table__num">vs book</th>
						</tr>
					</thead>
					<tbody>
						{#each report.listings as listing (listing.id)}
							<tr>
								<td>
									{listing.sellerName}
									{#if listing.isTreasury}
										<span class="e-tag">Treasury</span>
									{/if}
								</td>
								<td class="e-table__num">{listing.quantity.toLocaleString('de-DE')}</td>
								<td class="e-table__num"><Money amount={listing.pricePerShare} /></td>
								<td class="e-table__num">{premiumLabel(listing.premiumToBook)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if hasOwnListing}
			<p class="{BASE_CLASS}__note">
				One of these asks is your own. It is left out of anything you buy below, since an airline
				cannot buy shares back off itself.
			</p>
		{/if}

		{#if !isOwnAirline && buyableShares > 0 && plan}
			<div class="{BASE_CLASS}__order">
				<div class="e-field {BASE_CLASS}__quantity">
					<label class="e-field__label" for="dossier-quantity">Shares to buy</label>
					<input
						id="dossier-quantity"
						type="range"
						min="1"
						max={buyableShares}
						bind:value={orderQuantity}
					/>
					<input
						class="{BASE_CLASS}__number"
						type="number"
						min="1"
						max={buyableShares}
						bind:value={orderQuantity}
					/>
				</div>

				<div class="{BASE_CLASS}__preview">
					<div class="e-kv">
						<span class="e-kv__key">Cost</span>
						<span class="e-kv__value"><Money amount={plan.total} /></span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Average price paid</span>
						<span class="e-kv__value">
							{plan.averagePricePerShare === null
								? '—'
								: formatMoney(plan.averagePricePerShare)}
						</span>
					</div>
					<div class="e-kv">
						<span class="e-kv__key">Your stake afterwards</span>
						<span class="e-kv__value">
							{percent(stakeAfter)}
							{#if wouldTakeControl}
								<span class="e-tag e-tag--teal"><Crown size={12} /> Control</span>
							{/if}
						</span>
					</div>
				</div>

				<button
					class="e-button e-button--primary"
					type="button"
					disabled={submitting || plan.shortfall > 0 || !affordable}
					onclick={confirmBuy}
				>
					{#if !affordable}
						Not enough cash
					{:else if submitting}
						Buying…
					{:else}
						Buy {plan.filled} for <Money amount={plan.total} compact />
					{/if}
				</button>
			</div>
		{/if}
	</section>

	{#if bidPreview && !isOwnAirline}
		{@const preview = bidPreview}
		<section class="e-panel {BASE_CLASS}__takeover">
			<h3 class="e-panel__title"><Swords size={14} /> Takeover offer</h3>

			{#if preview.openBid}
				{@const open = preview.openBid}
				<p class="{BASE_CLASS}__note">
					Your offer of {formatMoney(open.pricePerShare)} a share for
					{open.sharesSought.toLocaleString('de-DE')} shares is on the table, with
					<strong>{formatCompactMoney(open.escrow)}</strong> escrowed. It closes in
					{daysLeft}
					{daysLeft === 1 ? 'day' : 'days'}, when every name on the register decides.
				</p>

				<div class="e-kv">
					<span class="e-kv__key">The board's response</span>
					<span class="e-kv__value">{open.defence ?? 'Nothing yet'}</span>
				</div>

				<button
					class="e-button e-button--ghost"
					type="button"
					disabled={bidding}
					onclick={cancelBid}
				>
					{bidding ? 'Withdrawing…' : `Withdraw · ${formatCompactMoney(refundFor(open.escrow, 0))} returned`}
				</button>
			{:else if preview.blockers.length > 0}
				{#each preview.blockers as blocker (blocker)}
					<p class="{BASE_CLASS}__note">{blocker}</p>
				{/each}
			{:else if bidQuote}
				{@const quote = bidQuote}
				<p class="{BASE_CLASS}__note">
					An offer reaches every name on the register, not only those who have listed — which is
					the one way to buy an airline that is selling nothing.
					{#if preview.controlPrice === null}
						On this register, though, no price would carry a majority: what the bidder does not
						already hold is not enough to reach one.
					{:else}
						Control needs
						<strong>{formatMoney(preview.controlPrice)}</strong> a share at today's prices.
					{/if}
				</p>

				<div class="{BASE_CLASS}__order">
					<div class="e-field">
						<label class="e-field__label" for="bid-price">Price per share</label>
						<input
							id="bid-price"
							class="{BASE_CLASS}__number"
							type="number"
							min={preview.minimumPrice}
							step="100"
							bind:value={bidPrice}
						/>
						<span class="{BASE_CLASS}__hint">
							At least {formatMoney(preview.minimumPrice)}
						</span>
					</div>

					<div class="e-field">
						<label class="e-field__label" for="bid-shares">Shares sought</label>
						<input
							id="bid-shares"
							class="{BASE_CLASS}__number"
							type="number"
							min="1"
							max={preview.sharesOutstanding}
							bind:value={bidShares}
						/>
						<span class="{BASE_CLASS}__presets">
							<button
								class="e-button e-button--ghost e-button--small"
								type="button"
								onclick={() => (bidShares = preview.sharesForControl)}
							>
								Enough for control
							</button>
							<button
								class="e-button e-button--ghost e-button--small"
								type="button"
								onclick={() => (bidShares = preview.sharesOutstanding)}
							>
								Everything ({preview.sharesOutstanding.toLocaleString('de-DE')})
							</button>
						</span>
					</div>

					<div class="{BASE_CLASS}__preview">
						<div class="e-kv">
							<span class="e-kv__key">Escrowed now</span>
							<span class="e-kv__value"><Money amount={quote.escrow} /></span>
						</div>
						<div class="e-kv">
							<span class="e-kv__key">Would tender today</span>
							<span class="e-kv__value">
								{quote.sharesWinnable.toLocaleString('de-DE')} of
								{quote.sharesSought.toLocaleString('de-DE')}
							</span>
						</div>
						<div class="e-kv">
							<span class="e-kv__key">Your stake afterwards</span>
							<!-- Shares as well as the percentage, because a controlling 1.501 rounds to
							     "50,0%" and would otherwise sit next to the crown reading as a
							     contradiction. -->
							<span class="e-kv__value">
								{quote.sharesAfter.toLocaleString('de-DE')} · {percent(
									quote.sharesAfter / TOTAL_SHARES
								)}
								{#if quote.wouldTakeControl}
									<span class="e-tag e-tag--teal"><Crown size={12} /> Control</span>
								{/if}
							</span>
						</div>
						<div class="e-kv">
							<span class="e-kv__key">Kept if it lapses · {(BID_FEE_SHARE * 100).toFixed(0)}% fee</span>
							<span class="e-kv__value"><Money amount={-feeIfItLapses} /></span>
						</div>
					</div>

					<button
						class="e-button e-button--primary"
						type="button"
						disabled={bidding || !canBid || !escrowAffordable}
						onclick={launchBid}
					>
						{#if !escrowAffordable}
							Not enough cash to escrow
						{:else if bidding}
							Launching…
						{:else}
							Launch offer · <Money amount={quote.escrow} compact />
						{/if}
					</button>
				</div>

				<div class="e-table-wrapper">
					<table class="e-table">
						<thead>
							<tr>
								<th>Holder</th>
								<th class="e-table__num">Shares</th>
								<th class="e-table__num">Wants at least</th>
								<th class="e-table__num">Would tender</th>
							</tr>
						</thead>
						<tbody>
							{#each quote.judgements as judgement (judgement.holderId)}
								<tr>
									<td>
										{judgement.name}
										{#if judgement.reason === 'treasury-desperate'}
											<span class="e-tag e-tag--yellow">Short of cash</span>
										{:else if judgement.reason === 'treasury'}
											<span class="e-tag">Treasury</span>
										{/if}
									</td>
									<td class="e-table__num">{judgement.quantity.toLocaleString('de-DE')}</td>
									<td class="e-table__num">
										{Number.isFinite(judgement.price) ? formatMoney(judgement.price) : 'Never sells'}
									</td>
									<td class="e-table__num">
										{judgement.tendering > 0 ? judgement.tendering.toLocaleString('de-DE') : '—'}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<p class="{BASE_CLASS}__note">
					An offer stays open for {BID_WINDOW_DAYS} days and the board has every one of them to
					react, so the register above is not necessarily the register that votes. A board sitting
					on plenty of cash holds out for far more than book value; one about to run out takes
					what it is offered — which is why starving a rival is the cheaper way to buy it.
					Anything paid to an airline's own treasury lands in the airline you are buying.
				</p>
			{/if}
		</section>
	{/if}

	<div class="e-grid-two">
		<section class="e-panel">
			<h3 class="e-panel__title"><Users size={14} /> Register</h3>
			{#each report.register as holder (holder.holderId)}
				<div class="e-kv">
					<span class="e-kv__key">
						{holder.name}
						{#if holder.controls}
							<span class="e-tag e-tag--teal"><Crown size={12} /> Controls</span>
						{/if}
					</span>
					<span class="e-kv__value">
						{holder.quantity.toLocaleString('de-DE')} · {percent(holder.quantity / TOTAL_SHARES)}
					</span>
				</div>
			{/each}
		</section>

		<section class="e-panel">
			<h3 class="e-panel__title"><Coins size={14} /> Day by day</h3>
			{#if report.days.length === 0}
				<p class="{BASE_CLASS}__note">No trading days inside the window yet.</p>
			{:else}
				<div class="e-table-wrapper">
					<table class="e-table">
						<thead>
							<tr>
								<th>Day</th>
								<th class="e-table__num">In</th>
								<th class="e-table__num">Out</th>
								<th class="e-table__num">Net</th>
							</tr>
						</thead>
						<tbody>
							{#each report.days as summary (summary.day)}
								<tr>
									<td>{dayKey(summary.day)}</td>
									<td class="e-table__num"><Money amount={summary.income} compact /></td>
									<td class="e-table__num"><Money amount={summary.expense} compact /></td>
									<td class="e-table__num">
										<Money amount={summary.income + summary.expense} compact colour signed />
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	</div>
{:else}
	<div class="e-panel e-empty">
		<div class="e-empty__title">Airline not found</div>
		<p>There is no airline behind that link.</p>
		<a class="e-button e-button--ghost e-button--small" href={backToMarket}>
			<ArrowLeft size={14} /> Back to the stock market
		</a>
	</div>
{/if}

<style lang="scss">
	.e-dossier {
		&__verdict {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-bottom: 20px;
		}

		&__statements {
			margin-bottom: 20px;
		}

		&__group {
			margin-top: 12px;
			color: #6b7280;
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.5px;
			text-transform: uppercase;
		}

		&__total {
			border-top: 1px solid #e5e7eb;
			border-bottom: none;
			font-weight: 600;
		}

		&__note {
			margin-top: 12px;
			color: #6b7280;
			font-size: 12px;
			line-height: 1.5;
		}

		&__book {
			margin-bottom: 20px;
		}

		&__order {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-end;
			gap: 20px;
			margin-top: 20px;
		}

		&__quantity {
			flex: 0 1 200px;
			margin-bottom: 0;
		}

		&__number {
			margin-top: 6px;
			text-align: right;
		}

		&__preview {
			flex: 1 1 240px;
			min-width: 240px;
		}

		&__takeover {
			margin-bottom: 20px;
		}

		&__hint {
			display: block;
			margin-top: 6px;
			color: #6b7280;
			font-size: 11px;
		}

		&__presets {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			margin-top: 6px;
		}
	}
</style>
