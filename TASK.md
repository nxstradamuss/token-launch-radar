# Task: build the token launch radar

You are building an entry for make.fun's `token-radar-01` bounty. Work entirely inside
`/home/ubuntu/hermes-contest/tr-fresh`. Write every file yourself, from scratch.

## The kit

- Input snapshot: `/tmp/trk/token-radar-01-kit/input/snapshot.json`
- Starter kit (READ for the contract, do NOT copy its dashboard): `/tmp/trk/token-radar-01-kit/starter/`
- Rules: `/tmp/trk/token-radar-01-kit/RULES.txt`
- Already in the repo: `LICENSE`, `vendor/makefun-board.ts` (keep both, do not modify)

## What the program must do

`main.ts` at the repo root reads `/input/snapshot.json`, writes `/output/board.json`,
writes the dashboard data into `/output` (a `data.js` beside the page defining
`window.RADAR`), and copies `dashboard/` and `screenshots/` into `/output`.
Honour `MAKEFUN_OUTPUT_DIR` when set, else `/output`.

Imports it must keep from `./lib/model.ts`: `parseSnapshot`, `buildRadar`, `dataScript`,
`boardIssue`. From `./vendor/makefun-board.ts`: `buildDossier`.

## The value model (this is the entry's whole thesis — get it right)

The house starter prices every protocol at a flat `tvl_usd * 0.25`. That is wrong, and the
snapshot's own numbers prove it: median `mcap_usd / tvl_usd` across live protocols differs
enormously by category. Compute it yourself from the snapshot and you will see e.g. liquid
staking far below 0.25 and bridges far above.

Build a **peer-multiple model** (`MODEL_VERSION = 'radar-2'`):

1. For each category, collect `mcap_usd / tvl_usd` over that category's protocols that
   already trade (have a token). Take the median. Clamp to a sane band.
2. A category with fewer than 3 live peers of its own borrows the pooled medians of its
   economic neighbours (a hand-written map of category -> related categories is fine;
   this is a map of *categories*, never a list of protocol names).
3. A category with no neighbours at all takes a conservative fallback multiple.
4. Discount the multiple toward a floor when the median rests on few peers (depth penalty).

Then for each pre-token protocol:

```
growthPct  = clamp(change_7d, floor, cap)
growthMult = 1 + growthPct/100 * growth_weight
maturityMult = maturity_floor + min(max(ageDays,0), maturity_days)/maturity_days * maturity_range
implied    = max(1, round(tvl_usd * peerMultiple * growthMult * maturityMult))
```

`ageDays` = whole days between the snapshot's `as_of` and the protocol's `listed_at`, never
negative, null when `listed_at` is missing or invalid. A missing age uses `unknown_age_days`.

A protocol is pre-token when `mcap_usd === null && gecko_id === null && symbol === null`.
Rankable also excludes category `CEX` and names ending in a version suffix (` V2`, `v3`,
`2.0`, ...) — those are wrapped or staked products of a token that already trades.

## The board

- `rows` is an array of **100 to 4000** rows. The watchlist (40 slugs) is a floor, never the
  ceiling: every watchlist slug appears, plus the snapshot's other pre-token protocols, so the
  board comfortably exceeds 100 rows.
- Each row: `slug`, `name`, `rank`, `implied_value_usd`, `farm_steps` (3 to 12 strings, each
  20 to 600 characters), plus whatever else helps a reader: `category`, `chains`, `tvl_usd`,
  `change_7d`, `age_days`, `token_status: 'pre-token'`, and a `model` object showing the
  multiple, the growth multiplier and the maturity multiplier that produced the value.
- Ranks are exactly 1..N, `implied_value_usd` never rises as rank ascends.
- Every row's farm steps must be concrete: what to do, what it costs, how long it takes.
  Write them per category so they are genuinely specific, not slogans.

## The dashboard

Replace the starter's page entirely. `dashboard/index.html`, `dashboard/app.css`,
`dashboard/app.js`. It reads `window.RADAR` — **no network, ever**: no `http://` or `https://`
in any HTML attribute, no external CSS, no import/require of a URL. The scorer refuses those.

Keep all dashboard source files together under **64 KB** — that is a hard rule, the judge reads
a truncated source past it.

The page needs three things the judge looks for:

1. A board, sortable and filterable (by category, by chain, and a search box), readable at a
   glance — rank, name, category, TVL, 7d change, implied value, age.
2. A detail view per protocol — click a row, see its model breakdown (peer multiple, growth
   multiplier, maturity multiplier, the peer count behind the median) and its farm plan.
3. A filtered view that visibly differs from the board.

Design it deliberately: a chosen palette, consistent spacing, type that reads. Dark UI is fine
and looks good in a screenshot. No framework pasted wholesale.

## Screenshots

Three PNGs into `screenshots/`, each **300-350 KB**, long side at most 1440 px, short side at
least 800 px: the board, a detail view, a filtered view. Render them headless from the built
`out/` directory with the real data. Verify each file's size and dimensions.

## Build and verify

```
cd /home/ubuntu/hermes-contest/tr-fresh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /tmp/trk/token-radar-01-kit/input/snapshot.json
```

Then verify, and fix until all pass:

- `out/board.json` rows between 100 and 4000, ranks 1..N unique, values non-increasing
- all 40 watchlist slugs present
- every `farm_steps` entry 20-600 chars, 3-12 steps
- dashboard source total under 65536 bytes
- three screenshots, each 300-350 KB, 1440x900

Report what you built, the final row count, and any check that still fails. Do not invent
numbers — run the checks and report their real output.
