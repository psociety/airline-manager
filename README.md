# Airline Manager Simulator

A browser airline-management game built with Svelte 5 and SvelteKit. There is no
backend: the world, its rival airlines and the whole simulation live in IndexedDB
in your browser.

```bash
npm install
npm run dev            # http://localhost:5173
npm run test           # unit, component and simulation tests
npm run test:probe     # balance probes: prints the tables, slow, run on demand
npm run check          # svelte-check
npm run build          # static SPA in build/
npm run data:airports  # rebuild the airport dataset from public sources
```

## How the world works

Time runs at **real-time 1:1**. Closing the tab does not pause the world: on your
next visit the engine replays every scheduled departure, day-close and AI turn you
missed (up to 30 days) and shows you a summary. The sidebar has **fast-forward**
buttons (6h / 1d / 1w) that push the world clock forward so you can see a week of
operations without waiting one.

**Founding an airline** gives you 30.000.000 €, all 3.000 of its shares and one
free gate at your chosen home airport. You can run several airlines; each one owns
a slug in the URL (`/raca-airline/fleet`) and the sidebar switches between them.

**Aircraft** are bought or leased from 147 real types — 119 passenger and 28
freighters. Your first one arrives instantly; every later order takes up to an hour,
counted down in the sidebar. You name it and lay out its cabin — a business seat costs
2 cabin slots and a first seat 4, so the mix is a real trade-off. A gate only accepts
aircraft up to its rated category.

**Freight** is a second business. A freighter has no cabin: it sells its hold, 3,4 t on
a Saab 340BF up to 134 t on a 747-8F. Every airport pair carries a freight demand of its
own, derived from the `cargo` modifiers in the airport data, and each route has a rate
per tonne you set alongside its fares. The two markets are separate — a passenger
aircraft never carries freight, and a freighter never carries passengers — but they
share the same routes, gates, crews and competition. Freight revenue lands in the ledger
as its own category. `npm run data:cargo` rebuilds the freighter catalogue from
`cargo_airplanes.html`, including downloading the illustrations.

**Gates** exist at all 300 airports in roughly real-world numbers (ATL has 192,
Asunción has 8), each rated for a maximum aircraft category based on its runway. The
15.204 stands are *derived* from the dataset rather than stored: the database records
only who owns what, so a fresh world seeds in about a tenth of a second and a save file
stays tiny. Every stand has a stable key — `ATL-A1` — which is what aircraft and routes
reference.

**Routes** link two gates and are flown in both directions: a leg departs
whichever end the aircraft is currently sitting at, and pays that airport's
landing and passenger fees. Demand for an airport pair is fixed forever; the live
variable is who else flies it.

What you know about a market has three stages:

1. **Before opening the route** — nothing. No demand, no fare guidance. You can
   see which airlines already fly the pair and what they charge, because that is
   public, but the market itself is dark.
2. **Once you operate it** — a fuzzy estimate: bracketed ranges and labels like
   "medium demand", learned from what your own flights carry. Good enough to price
   by feel, too vague to optimise against.
3. **Once you pay the audit** (30k–1M €, quoted per airline and pair) — the exact
   daily demand per class, the fare the market considers fair, and load and revenue
   projections on the pricing screen. Bought once, yours for that pair forever.

An unaudited route never exposes the exact ideal fare anywhere — not through its
opening fares, not through the "use these fares" button, not through the fill
indicator. All three work from the fuzzed midpoint, so the audit cannot be
reverse-engineered for free.

**Scheduling** is a 7×24 grid per aircraft. Drag a route onto an hour and it
occupies as many columns as the round of block time it needs. An aircraft can only
fly a leg that touches the airport it will be at, and the grid warns you when a
leg would be skipped. Build Monday once and **copy it across the week** rather than
dragging 40 legs by hand, or **reset** the aircraft's week and start over.

**The dashboard map** draws your network and every aircraft currently in the air,
each one rotated along its track and drawn with the icon for its type — twin
turboprop, twin jet, four-engine, big four-engine or business jet — from the
`static/icons/airplanes.png` spritesheet. Hover an aircraft for its route and type.
The classification lives in `src/lib/data/aircraft_sprites.ts`.

**Maintenance is your call.** Each type has a service interval in kilometres. Fly
past it and every departure carries a rising accident risk, shown on the fleet
card. After an accident you either pay the indemnity or fight it in court — an
even chance of paying nothing, or the damages plus a 10–100% penalty.

**Workers** come with everything you own: each aircraft needs its crew, each route
46 staff and each gate 10, all added as *external* workers at 330 €/day. Hiring
them costs 275 € once and drops them to 294 €/day, paying for itself in eight days.

**The stock market** trades every airline's 3.000 shares. AI carriers float equity
when short of cash and buy it back when flush. Pass 50% of an airline and you take
control of it: its AI stops and it appears in your airline switcher.

**Takeover offers** reach the airlines that float nothing at all. Name a price and a
number of shares, and the cash is escrowed while the offer sits open for three days;
then every name on the register decides for itself. What each one wants is a multiple
of book value: a broker desk parts with a position at its own profit-taking level, and
a board holds out for 1,9× book — unless it is within ten days of running out of cash,
when it takes 1,15× and little argument. That is the whole strategy. **Starve a rival,
then bid.** The board is not passive in the meantime: news of an offer re-rates the
stock upward, and a board with cash to spare spends it buying its own float back out of
your reach. An offer that wins nothing is refunded less a 2% fee and hardens the board
against another for a fortnight.

Every movement of money is written to `transaction_records`, which is what the
accounting screen reads — grouped by day, split by category.

## The airport dataset

300 airports across 157 countries, with real coordinates, names, IATA/ICAO codes and
runway lengths. `scripts/build-airports.mjs` (`npm run data:airports`) builds it from
two public sources — [OurAirports](https://ourairports.com) for the airport and runway
facts, and Wikidata for annual passenger figures — and writes
`src/lib/data/airports_data.json` plus the gate counts. The output is committed, so the
game and its tests never touch the network, and the script is idempotent: running it
twice yields the same 300 airports.

Real data is used wherever it exists. Three things are deliberately game values, and are
commented as such in the script: **tier** (banded from real traffic), **airport charges**
(interpolated by tier) and **demand character** (no public dataset exists for how
touristic or business-driven an airport is). Gate counts for the original hundred are
hand-curated real-world figures; the rest are fitted from traffic and runway count, which
lands within about 20% of the curated numbers.

`hubPrice`, `isHubPurchasable`, `icaoCode` and `timezone` are populated but unread by the
game — the simulation runs in UTC.

## Sharing a save

The landing page has **Export save** (writes the whole world to a JSON file) and
**Import save** (replaces your world with one). To have somebody debug your game,
export it, drop the file at the repository root as `savegame.json`, and run:

```bash
npx vitest run src/lib/db/savegame.inspect.test.ts
```

That prints every airline, route and aircraft, and for each aircraft why it is or
is not flying. Without the file the test skips itself.

## Layout

```
src/lib/data/      datasets + derived stats (employees, maintenance, lease, fuel)
src/lib/db/        Dexie schema, repository (all mutations), world seed
src/lib/engine/    demand, economy, flights, maintenance, AI, the clock and catch-up
src/lib/state/     runes stores: world clock, revision counter, toasts
src/lib/components/ shared UI built from design.html's tokens
src/routes/        landing, onboarding, and the [slug]/… company screens
```

`postTransaction` in `src/lib/db/repo.ts` is the only place cash ever moves, which
keeps the ledger and every balance in step — there is a test that proves it.

Stands are the other structural thing worth knowing: `gatesForAirport` in
`src/lib/data/gates.ts` derives an airport's stands on demand (memoised), while the
`gate_ownership` table records only purchases. Anything needing a stand joins the two
through `companyGates`, `availableGatesAt` or `ownedGate` in the repository. Schema
versions 2 and 3 migrate worlds from the era when all fifteen thousand stands were rows,
and `importSave` does the same for version 1 save files.

## Balance notes

The spec fixes the wage rules (46 staff per route, 330 €/day external), which makes
short-haul thin: a single 500 km route needs roughly four daily rotations of a
150-seater to clear its costs. Long-haul with a widebody is where the money is.
Fares, demand weighting and maintenance pricing were calibrated against that
constraint and are all constants at the top of `engine/demand.ts` and
`engine/economy.ts` if you want to tune them.
