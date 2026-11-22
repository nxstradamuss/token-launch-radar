// The token radar's value model: radar-2, a peer-multiple model.
//
// The house starter prices every protocol at `tvl_usd * 0.25`. That single number is wrong, and the
// snapshot's own figures say so: across protocols that already trade, the median market cap per dollar
// of TVL is about 0.03 for liquid staking and about 0.75 to 1.2 for bridges. A flat multiple therefore
// overprices one half of the universe and underprices the other.
//
// radar-2 derives the multiple from the market instead:
//
//   1. For a category, take the median of mcap_usd / tvl_usd over that category's protocols that
//      already trade. Clamp it into a sane band.
//   2. A category with fewer than MIN_OWN_PEERS live peers of its own borrows the pooled median of its
//      economic neighbours, from NEIGHBOURS below (a map of categories, never a list of protocols).
//   3. A category with no neighbours at all takes FALLBACK_MULTIPLE.
//   4. The multiple is pulled toward PEER_FLOOR when the median rests on few peers (a depth penalty).
//
// Then, for every pre-token protocol:
//
//   growthPct    = clamp(change_7d, growth_floor, growth_cap)
//   growthMult   = 1 + growthPct / 100 * growth_weight
//   maturityMult = maturity_floor + min(max(ageDays, 0), maturity_days) / maturity_days * maturity_range
//   implied      = max(1, round(tvl_usd * peerMultiple * growthMult * maturityMult))
//
// ageDays is the whole-day distance from the snapshot's as_of back to listed_at, never negative, and
// null when listed_at is missing or unparseable; a null age is modelled at unknown_age_days.
//
// No protocol name is ever special-cased. The same function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants. The dashboard prints them and the page states every one it used. */
export interface ModelConstants {
  /** How much of a seven-day TVL move reaches the implied value. */
  growth_weight: number;
  /** The growth clamp, in per cent. */
  growth_floor: number;
  growth_cap: number;
  /** Maturity: floor plus up to range, reached at maturity_days of age. */
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  /** The age a protocol with no listed_at is modelled at. */
  unknown_age_days: number;
  /** The band a peer median is clamped into. */
  peer_band_min: number;
  peer_band_max: number;
  /** The multiple a thin median is pulled toward, and how thin is thin. */
  peer_floor: number;
  depth_full: number;
  depth_min: number;
  /** A category with no live peer and no neighbour. */
  fallback_multiple: number;
  /** How many live peers a category needs before it stands on its own median. */
  min_own_peers: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  peer_band_min: 0.02,
  peer_band_max: 3.0,
  peer_floor: 0.05,
  depth_full: 8,
  depth_min: 0.55,
  fallback_multiple: 0.1,
  min_own_peers: 3,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/**
 * The economic neighbourhood of each category: the categories whose live multiples stand in when a
 * category has too few live peers of its own. A map of categories, never a list of protocol names.
 */
export const NEIGHBOURS: Record<string, string[]> = {
  Lending: ['CDP', 'Uncollateralized Lending', 'Collateral Markets', 'Collateral Management'],
  CDP: ['Lending', 'CDP Manager', 'Collateral Markets'],
  'CDP Manager': ['CDP', 'Lending', 'Collateral Markets'],
  'Uncollateralized Lending': ['Lending', 'CDP', 'Collateral Markets'],
  'Collateral Markets': ['Lending', 'CDP', 'Collateral Management'],
  'Collateral Management': ['Lending', 'Collateral Markets', 'CDP'],
  Dexs: ['Liquidity Manager', 'Yield Aggregator'],
  'Liquidity Manager': ['Dexs', 'Yield Aggregator'],
  Yield: ['Yield Aggregator', 'Lending', 'Farm'],
  'Yield Aggregator': ['Yield', 'Farm', 'Lending'],
  Farm: ['Yield', 'Yield Aggregator', 'Leveraged Farming'],
  'Leveraged Farming': ['Yield', 'Yield Aggregator', 'Dexs'],
  'Liquid Staking': ['Staking Pool', 'Restaking', 'Liquid Restaking'],
  'Staking Pool': ['Liquid Staking', 'Restaking', 'Liquid Restaking'],
  Restaking: ['Liquid Restaking', 'Liquid Staking', 'Restaked BTC'],
  'Liquid Restaking': ['Restaking', 'Liquid Staking', 'Restaked BTC'],
  'Restaked BTC': ['Restaking', 'Liquid Restaking', 'Anchor BTC', 'Decentralized BTC'],
  'Anchor BTC': ['Restaked BTC', 'Decentralized BTC', 'Restaking'],
  'Decentralized BTC': ['Anchor BTC', 'Restaked BTC', 'Restaking'],
  Bridge: ['Canonical Bridge', 'Cross Chain Bridge'],
  'Canonical Bridge': ['Bridge', 'Cross Chain Bridge'],
  'Cross Chain Bridge': ['Bridge', 'Canonical Bridge'],
  RWA: ['Indexes', 'DOR', 'Lending'],
  Indexes: ['RWA', 'DOR', 'Yield Aggregator'],
  DOR: ['RWA', 'Indexes'],
  'Risk Curators': ['Onchain Capital Allocator', 'Yield', 'Yield Aggregator', 'Lending'],
  'Onchain Capital Allocator': ['Risk Curators', 'Yield', 'Lending'],
  'Basis Trading': ['Derivatives', 'Yield', 'Lending'],
  Derivatives: ['Basis Trading', 'Options', 'Synthetics', 'Interest Rate Derivatives'],
  Options: ['Derivatives', 'Options Vault', 'Synthetics'],
  'Options Vault': ['Options', 'Derivatives', 'Yield Aggregator'],
  Synthetics: ['Derivatives', 'Options', 'Basis Trading'],
  'Interest Rate Derivatives': ['Derivatives', 'Lending', 'Basis Trading'],
  'Prediction Market': ['Derivatives', 'Options'],
  'Dual-Token Stablecoin': ['Algo-Stables', 'Stablecoin Issuer', 'Reserve Currency'],
  'Algo-Stables': ['Dual-Token Stablecoin', 'Stablecoin Issuer', 'Reserve Currency'],
  'Stablecoin Issuer': ['Dual-Token Stablecoin', 'Algo-Stables', 'Reserve Currency'],
  'Reserve Currency': ['Stablecoin Issuer', 'Algo-Stables'],
  'Stablecoin Wrapper': ['Dual-Token Stablecoin', 'Stablecoin Issuer', 'Payments'],
  CeDeFi: ['CEX', 'Lending', 'Yield'],
  Payments: ['CeDeFi', 'Stablecoin Issuer', 'Dexs'],
  'Crypto Card Issuer': ['CeDeFi', 'Payments', 'Stablecoin Issuer'],
  Chain: ['Dexs', 'Lending', 'Bridge'],
  'Token Locker': ['Governance Incentives', 'Launchpad', 'Farm'],
  'Governance Incentives': ['Token Locker', 'Farm', 'Yield'],
  Launchpad: ['Token Locker', 'Farm', 'Dexs'],
  Insurance: ['Lending', 'Risk Curators', 'Synthetics'],
  Privacy: ['Bridge', 'Dexs', 'Payments'],
  'AI Agents': ['Decentralized AI', 'Launchpad', 'Farm'],
  'Decentralized AI': ['AI Agents', 'Launchpad'],
  'NFT Marketplace': ['Dexs', 'Launchpad'],
  'OTC Marketplace': ['Dexs', 'Lending'],
  CEX: ['CeDeFi', 'Payments'],
};

/** One category's peer multiple and the evidence behind it. */
export interface PeerStat {
  category: string;
  /** The multiple the model uses, after the band and the depth penalty. */
  multiple: number;
  /** The raw median of the live peers the multiple rests on. */
  median: number;
  /** How many live protocols stand behind that median. */
  peers: number;
  /** Whether the median is the category's own, borrowed from neighbours, or the fallback. */
  source: 'own' | 'neighbours' | 'fallback';
  /** The neighbour categories that actually supplied live peers. */
  borrowed_from: string[];
  /** The depth penalty's factor: 1 is no discount, depth_min is the thinnest. */
  depth_factor: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The model's account of one row: what produced its implied value. */
export interface RowModel {
  peer_multiple: number;
  peer_median: number;
  peer_count: number;
  peer_source: PeerStat['source'];
  borrowed_from: string[];
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
  age_assumed: number;
  tvl_usd: number;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  watchlisted: boolean;
  implied_value_usd: number;
  model: RowModel;
  farm_steps: string[];
}

/** The dashboard's view of one row: the board row plus what the detail panel shows. */
export interface RadarRow extends BoardRow {}

/** A protocol whose token already trades: the market's own value, shown apart from the board. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  /** mcap_usd / tvl_usd: the number the peer table is built from. */
  ratio: number | null;
}

/** A pre-token record the board sets aside, and why. */
export interface ExcludedRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  reason: string;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  live_total: number;
  /** Pre-token records, how many the board ranks, and how many it sets aside as derivatives. */
  pretoken_total: number;
  excluded: ExcludedRow[];
  rows: RadarRow[];
  live: LiveRow[];
  peers: PeerStat[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `listed_at` to `as_of`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The mcap/tvl ratio of every protocol in `category` that already trades. */
function liveRatios(protocols: SnapshotProtocol[], category: string): number[] {
  const out: number[] = [];
  for (const p of protocols) {
    if (p.category !== category) continue;
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const r = p.mcap_usd / p.tvl_usd;
    if (Number.isFinite(r) && r > 0) out.push(r);
  }
  return out;
}

/** One category's peer statistic, from its own live peers and its neighbours'. */
function peerStat(category: string, ratios: (c: string) => number[], model: ModelConstants): PeerStat {
  const own = ratios(category);
  let rawMedian: number;
  let peers: number;
  let source: PeerStat['source'];
  let borrowed: string[] = [];

  if (own.length >= model.min_own_peers) {
    rawMedian = medianOf(own);
    peers = own.length;
    source = 'own';
  } else {
    // Fewer than three live peers of its own: pool the neighbours' live peers.
    const pooled = [...own];
    for (const neighbour of NEIGHBOURS[category] ?? []) {
      const r = ratios(neighbour);
      if (r.length === 0) continue;
      pooled.push(...r);
      borrowed.push(neighbour);
    }
    if (pooled.length > 0) {
      rawMedian = medianOf(pooled);
      peers = pooled.length;
      source = 'neighbours';
    } else {
      rawMedian = model.fallback_multiple;
      peers = 0;
      source = 'fallback';
    }
  }

  // The depth penalty: the fewer peers behind the median, the closer the multiple sits to the floor.
  const trust = peers === 0 ? 0 : Math.min(1, peers / model.depth_full);
  const depthFactor = source === 'fallback' ? 1 : model.depth_min + (1 - model.depth_min) * trust;
  const pulled = model.peer_floor + (rawMedian - model.peer_floor) * depthFactor;
  const multiple = Math.min(model.peer_band_max, Math.max(model.peer_band_min, pulled));

  return {
    category,
    multiple: round4(multiple),
    median: round4(rawMedian),
    peers,
    source,
    borrowed_from: borrowed,
    depth_factor: round4(depthFactor),
  };
}

/** The peer table for every category the snapshot names. */
export function buildPeerTable(protocols: SnapshotProtocol[], model: ModelConstants = MODEL): Map<string, PeerStat> {
  const cache = new Map<string, number[]>();
  const ratios = (c: string): number[] => {
    let v = cache.get(c);
    if (v === undefined) {
      v = liveRatios(protocols, c);
      cache.set(c, v);
    }
    return v;
  };
  const table = new Map<string, PeerStat>();
  for (const p of protocols) {
    if (p.category === null || table.has(p.category)) continue;
    table.set(p.category, peerStat(p.category, ratios, model));
  }
  return table;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * The categories the house's own watchlist rule treats as products of a token that already trades:
 * exchanges, the bridges that carry a chain's canonical or wrapped asset, and the receipt-token
 * categories. A protocol in one of these is a route or a wrapper, not a launch of its own.
 */
const WRAPPER_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge']);

/** A name that says outright it is a wrapped, staked or bridged product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking|bridged|receipt)\b/i;

/** A name that begins with an exchange's name: the house rule sets these aside too. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Why a pre-token record is not a launch candidate, or null when it is one. */
export function notRankableReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'records a token that already trades';
  if (p.category !== null && WRAPPER_CATEGORIES.has(p.category)) return `a ${p.category.toLowerCase()} route, not a launch of its own`;
  if (VERSIONED.test(p.name)) return 'a versioned pool of another protocol';
  if (WRAPPED_WORD.test(p.name)) return 'a wrapped or staked product by name';
  if (EXCHANGE_PREFIX.test(p.name)) return 'named for an exchange';
  return null;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged product
 * of a token that already trades. The house states that exclusion for its watchlist (CEX, the bridge
 * categories, version markers, wrapped/staked/staking names, exchange-named protocols); the radar applies
 * the same test to the whole board, so a bridge route never outranks a protocol still to come.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return notRankableReason(p) === null;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The three multipliers and the implied value one protocol gets. */
export function scoreProtocol(
  protocol: SnapshotProtocol,
  asOf: string,
  peers: PeerStat,
  model: ModelConstants = MODEL,
): { implied: number; model: RowModel } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageAssumed = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageAssumed, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * peers.multiple * growthMult * maturityMult));
  return {
    implied,
    model: {
      peer_multiple: peers.multiple,
      peer_median: peers.median,
      peer_count: peers.peers,
      peer_source: peers.source,
      borrowed_from: peers.borrowed_from,
      growth_pct: round4(growthPct),
      growth_multiplier: round4(growthMult),
      maturity_multiplier: round4(maturityMult),
      age_days: age,
      age_assumed: ageAssumed,
      tvl_usd: protocol.tvl_usd,
    },
  };
}

/* ------------------------------------------------------------------ farm plans */

/** A step as one string: its action, then its cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** An estimated gas bill per transaction on a chain, in whole dollars, as a short string. */
function gasOf(p: SnapshotProtocol): string {
  const c = chainOf(p).toLowerCase();
  if (c.includes('ethereum')) return '$6-14';
  if (c.includes('solana')) return '$0.01-0.05';
  if (c.includes('tron')) return '$0.5-1.5';
  if (c.includes('arbitrum') || c.includes('base') || c.includes('optimism') || c.includes('linea')) return '$0.10-0.60';
  if (c.includes('polygon') || c.includes('bnb') || c.includes('avalanche')) return '$0.02-0.20';
  return '$0.05-0.50';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 120) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** What one category's farm plan actually asks you to do. */
interface PlanSpec {
  /** The one-sentence setup action. */
  setup: string;
  /** What capital mix the position takes. */
  mix: string;
  /** The recurring qualifying action. */
  cadence: string;
  /** Where the protocol's own rewards or points page sits, in words. */
  claim: string;
  /** The thing that goes wrong in this category, in one clause. */
  risk: string;
  /** A second, smaller position that counts toward the same snapshot. */
  extra: string;
}

/** The plan specs, keyed by DefiLlama's category. */
const PLANS: Record<string, PlanSpec> = {
  Lending: {
    setup: 'supply a blue-chip asset as collateral and borrow a stablecoin against it at no more than half the allowed loan-to-value',
    mix: '60% USDC supplied, 40% held back as a buffer against a liquidation',
    cadence: 'borrow a little more, repay a little, or move collateral once a week so the position is active across snapshots',
    claim: 'the protocol app\'s own rewards tab, where supply and borrow incentives accrue',
    risk: 'a collateral price fall can liquidate the loan, so keep the health factor above 1.5',
    extra: 'a second wallet that only supplies, never borrows',
  },
  CDP: {
    setup: 'open a collateralised debt position, deposit the accepted collateral and mint the protocol\'s stable asset at a conservative ratio',
    mix: '70% of the capital in collateral, 30% kept in the stable asset to repay with',
    cadence: 'mint a small extra amount and repay it once a week, or adjust the collateral ratio',
    claim: 'the protocol\'s own stability-fee and governance rewards page',
    risk: 'a collateral drop or a fee vote can force a repayment, so watch the ratio weekly',
    extra: 'a small stability-pool deposit if the protocol runs one',
  },
  'CDP Manager': {
    setup: 'open a collateralised debt position through the manager, deposit the accepted collateral and mint at a conservative ratio',
    mix: '70% of the capital in collateral, 30% kept in the stable asset to repay with',
    cadence: 'mint a small extra amount and repay it once a week so the position stays active',
    claim: 'the manager\'s own rewards and fee page',
    risk: 'a collateral drop or a fee change can force a repayment, so watch the ratio weekly',
    extra: 'a small stability-pool deposit if the manager runs one',
  },
  'Uncollateralized Lending': {
    setup: 'lend into the protocol\'s pooled market and, if the pool is open to it, take one small undercollateralised line',
    mix: '80% USDC lent, 20% kept liquid in case a drawdown needs topping up',
    cadence: 'add or withdraw a small amount once a week, or claim and restake the interest',
    claim: 'the pool\'s own interest and rewards tab',
    risk: 'undercollateralised credit depends on the borrower, so size the line at what you can lose',
    extra: 'a second wallet lending only, with no credit line',
  },
  'Collateral Markets': {
    setup: 'deposit an accepted collateral asset into the market and borrow the stable asset against it at a safe ratio',
    mix: '65% collateral, 35% stable asset as the repayment buffer',
    cadence: 'adjust the position once a week: add collateral, repay a little, or rebalance',
    claim: 'the market\'s own supply and borrow rewards tab',
    risk: 'thin collateral markets gap on liquidation, so keep the ratio well under the limit',
    extra: 'a supply-only position on a second market the protocol lists',
  },
  'Collateral Management': {
    setup: 'deposit the accepted collateral into the managed vault and let the manager carry the position',
    mix: '80% in the vault, 20% held back for a top-up if the manager calls for one',
    cadence: 'check the vault\'s ratio once a week and add or withdraw a small amount',
    claim: 'the vault\'s own fee and rewards page',
    risk: 'the manager\'s rebalancing is the risk, so read the vault\'s collateral rules first',
    extra: 'a second vault with a different collateral asset',
  },
  Dexs: {
    setup: 'provide two-sided liquidity to the protocol\'s deepest pool on its main chain, starting with the stable pair',
    mix: 'half USDC and half the paired asset, or a stable-to-stable pair if the protocol has one',
    cadence: 'rebalance or re-range the position once a week and collect the fees you earned',
    claim: 'the protocol\'s own farm and fee-claim page',
    risk: 'impermanent loss bites when the pair diverges, so a stable pair is the safer first position',
    extra: 'a small position in a second pool the protocol lists',
  },
  'Liquidity Manager': {
    setup: 'open a managed liquidity position on the protocol\'s main pair and set a range around the current price',
    mix: 'the pair\'s two assets in the pool\'s own ratio, with a reserve for re-ranging',
    cadence: 're-range the position once a week and harvest the fees',
    claim: 'the manager\'s own fee and rewards page',
    risk: 'a range that price leaves stops earning, so keep the band wide enough for a week of moves',
    extra: 'a second, wider range on the same pair',
  },
  Yield: {
    setup: 'deposit into the protocol\'s headline stablecoin or blue-chip vault and keep the receipt token',
    mix: 'USDC into the steadiest vault, or a blue-chip asset if the vault only takes one',
    cadence: 'compound the yield or add a small deposit once a week',
    claim: 'the vault\'s own rewards and points tab',
    risk: 'a vault strategy can change under you, so read what it holds before the deposit',
    extra: 'a smaller deposit in a second vault with a different strategy',
  },
  'Yield Aggregator': {
    setup: 'deposit into the aggregator\'s top stablecoin vault and keep the receipt token in the same wallet',
    mix: 'USDC into the steadiest vault the aggregator routes to',
    cadence: 'harvest and redeposit the yield once a week, or move to a better vault',
    claim: 'the aggregator\'s own rewards and points tab',
    risk: 'the aggregator adds a layer over the underlying vault, so check both contracts',
    extra: 'a smaller deposit in a second vault the aggregator lists',
  },
  Farm: {
    setup: 'stake the protocol\'s farm token or its liquidity receipt in the main farm and keep the position',
    mix: 'the farm asset the pool takes, plus a reserve to pay the unstaking fee if there is one',
    cadence: 'claim and restake the farm rewards once a week',
    claim: 'the farm\'s own rewards page',
    risk: 'farm tokens fall faster than the yield pays, so price the position in dollars weekly',
    extra: 'a small position in a second farm the protocol runs',
  },
  'Leveraged Farming': {
    setup: 'open one leveraged liquidity position at the lowest leverage the protocol offers, on a stable pair',
    mix: 'the equity the protocol requires, with a buffer against a margin call',
    cadence: 'check the leverage ratio once a week and deleverage if the buffer thins',
    claim: 'the protocol\'s own rewards and points tab',
    risk: 'leverage turns a small adverse move into a liquidation, so never run the maximum',
    extra: 'an unleveraged position in the same pool as a control',
  },
  'Liquid Staking': {
    setup: 'stake the chain\'s native asset through the protocol and hold the liquid receipt token it issues',
    mix: 'the chain\'s native asset, in one deposit, with the gas left over',
    cadence: 'leave the receipt staked and, once a week, check that the protocol still carries the best rate',
    claim: 'the protocol\'s own points or rewards page for the receipt token',
    risk: 'the receipt trades at a discount in a panic, so do not plan to exit it in one block',
    extra: 'a second receipt from a different validator set if the protocol offers one',
  },
  'Staking Pool': {
    setup: 'delegate the chain\'s native asset to the pool and keep the receipt or the delegation record',
    mix: 'the chain\'s native asset, in one deposit, with the gas left over',
    cadence: 'check the validator set and the rate once a week, and redelegate only if it degrades',
    claim: 'the pool\'s own rewards page',
    risk: 'a validator slashing hits the whole pool, so prefer a pool that spreads the stake',
    extra: 'a smaller delegation to a second pool for comparison',
  },
  Restaking: {
    setup: 'restake the staked or liquid-staked asset into the protocol and keep the restaking receipt',
    mix: 'the staked asset the protocol accepts, with a reserve for the withdrawal queue',
    cadence: 'check the operator set and the rewards once a week, and add a small amount if the cap is open',
    claim: 'the protocol\'s own points page for restaked positions',
    risk: 'restaking adds slashing conditions on top of staking, so read which services you secure',
    extra: 'a second operator or a second receipt if the protocol allows it',
  },
  'Liquid Restaking': {
    setup: 'deposit the staked asset into the protocol and hold the liquid restaking token it issues',
    mix: 'the staked asset the protocol accepts, with a reserve for the withdrawal queue',
    cadence: 'leave the receipt staked and check the points and the rate once a week',
    claim: 'the protocol\'s own points page for the liquid restaking token',
    risk: 'the receipt carries both staking and restaking slashing, so size it as one position',
    extra: 'a small deposit in a second receipt the protocol issues',
  },
  'Restaked BTC': {
    setup: 'deposit the wrapped bitcoin the protocol accepts and take the restaked receipt it issues',
    mix: 'wrapped BTC in one deposit, with a reserve for the withdrawal delay',
    cadence: 'check the operator set and the points once a week',
    claim: 'the protocol\'s own points page for restaked BTC',
    risk: 'BTC restaking carries both custody and slashing risk, so use only audited wrappers',
    extra: 'a smaller deposit in a second vault the protocol runs',
  },
  'Anchor BTC': {
    setup: 'mint the protocol\'s anchored bitcoin against the collateral it accepts, or deposit BTC for the anchored receipt',
    mix: 'BTC or the accepted collateral, with a buffer above the minimum ratio',
    cadence: 'check the ratio and the rewards once a week, and adjust a small amount',
    claim: 'the protocol\'s own rewards page for the anchored asset',
    risk: 'an anchor peg can slip in a stress event, so keep the ratio above the floor',
    extra: 'a small stability-pool position if the protocol runs one',
  },
  'Decentralized BTC': {
    setup: 'mint the protocol\'s decentralised bitcoin against the collateral it accepts, or deposit BTC for the receipt',
    mix: 'BTC or the accepted collateral, with a buffer above the minimum ratio',
    cadence: 'check the ratio and the rewards once a week, and adjust a small amount',
    claim: 'the protocol\'s own rewards page for the minted asset',
    risk: 'the peg and the collateral both move, so keep the ratio well above the floor',
    extra: 'a small stability-pool position if the protocol runs one',
  },
  Bridge: {
    setup: 'bridge a stablecoin from its main chain to the protocol\'s destination chain and keep a small balance there',
    mix: 'USDC bridged in one direction, plus the gas for the return trip',
    cadence: 'bridge a small amount back and forth once a week, or use the bridged balance in a pool',
    claim: 'the bridge\'s own points or rewards page for bridged volume',
    risk: 'a bridge is a custody risk, so never bridge more than you would leave there overnight',
    extra: 'a second route through the same bridge to a different chain',
  },
  'Canonical Bridge': {
    setup: 'bridge a stablecoin through the chain\'s canonical bridge to the destination chain and keep a balance there',
    mix: 'USDC bridged in one direction, plus the gas for the return trip',
    cadence: 'bridge a small amount back once a week, or use the bridged balance in a pool',
    claim: 'the bridge\'s own points page, if it runs one, and the destination chain\'s own programs',
    risk: 'canonical bridges are slow to exit, so plan the return trip days ahead',
    extra: 'a second destination chain the same bridge serves',
  },
  'Cross Chain Bridge': {
    setup: 'bridge a stablecoin across two chains the protocol serves and keep a small balance on the far side',
    mix: 'USDC bridged in one direction, plus the gas for the return trip',
    cadence: 'bridge a small amount back and forth once a week to keep the route active',
    claim: 'the bridge\'s own points page for bridged volume',
    risk: 'message bridges add relayer risk, so prefer the route with the deepest liquidity',
    extra: 'a second route the bridge serves, with a smaller amount',
  },
  RWA: {
    setup: 'subscribe to the protocol\'s tokenised yield asset, or mint it against the collateral it accepts',
    mix: 'USDC into the shortest-dated product, or the accepted collateral if it is a mint',
    cadence: 'check the yield and the redemption window once a week, and roll a small amount',
    claim: 'the protocol\'s own rewards page for holders',
    risk: 'redemption can be gated by the issuer, so read the lock-up before the deposit',
    extra: 'a smaller position in a second product the protocol lists',
  },
  Indexes: {
    setup: 'mint or buy the protocol\'s index token and hold it in the wallet you farm with',
    mix: 'USDC into the index, in one mint if the protocol allows it',
    cadence: 'check the index composition and the rewards once a week',
    claim: 'the index\'s own rewards page',
    risk: 'the index rebalances under you, so read the weights before sizing the position',
    extra: 'a small mint of a second index the protocol runs',
  },
  DOR: {
    setup: 'deposit into the protocol\'s digital-asset treasury product and keep the receipt',
    mix: 'USDC into the product, in one deposit',
    cadence: 'check the yield and the redemption terms once a week',
    claim: 'the protocol\'s own rewards page for holders',
    risk: 'the product holds off-chain or wrapped assets, so read the custody terms',
    extra: 'a smaller deposit in a second product the protocol runs',
  },
  'Risk Curators': {
    setup: 'deposit into one of the curator\'s vaults, choosing the steadiest collateral and the lowest fee tier',
    mix: 'USDC into the vault with the shortest redemption queue',
    cadence: 'check the vault\'s allocation and the curator\'s fee once a week',
    claim: 'the curator\'s own points page and the vault\'s rewards tab',
    risk: 'the curator chooses the collateral, so read the allocation before you deposit',
    extra: 'a smaller deposit in a second vault the same curator runs',
  },
  'Onchain Capital Allocator': {
    setup: 'deposit into one of the allocator\'s vaults and keep the shares in the farming wallet',
    mix: 'USDC into the vault with the deepest liquidity and the shortest queue',
    cadence: 'check the allocation and the fee once a week, and move a small amount if a better vault opens',
    claim: 'the allocator\'s own points page and the vault\'s rewards tab',
    risk: 'the allocator moves capital between venues, so read where it sits today',
    extra: 'a smaller deposit in a second vault the allocator runs',
  },
  'Basis Trading': {
    setup: 'deposit into the protocol\'s basis or delta-neutral vault and keep the receipt',
    mix: 'USDC into the vault, in one deposit, with a reserve for fees',
    cadence: 'check the funding rate and the vault\'s yield once a week',
    claim: 'the vault\'s own rewards and points page',
    risk: 'basis trades lose when funding flips, so read the vault\'s hedge before sizing',
    extra: 'a smaller deposit in a second vault with a different venue',
  },
  Derivatives: {
    setup: 'deposit margin into the protocol and open one small position, hedged, on its deepest market',
    mix: 'USDC margin, no more than a fifth of the capital at risk per position',
    cadence: 'roll or close the position once a week and keep the margin topped up',
    claim: 'the protocol\'s own trading-rewards page',
    risk: 'a perp position can be liquidated in a wick, so keep the leverage at 2x or below',
    extra: 'a second small position on a different market',
  },
  Options: {
    setup: 'deposit margin and buy one short-dated option, or sell one covered option, on the protocol',
    mix: 'USDC premium or margin, capped at what you can lose on the position',
    cadence: 'roll the option once a week as it expires',
    claim: 'the protocol\'s own rewards page for traders',
    risk: 'a bought option can expire worthless, so treat the premium as the whole cost',
    extra: 'a second small position on a different strike',
  },
  'Options Vault': {
    setup: 'deposit into the protocol\'s option-selling vault and keep the vault shares',
    mix: 'USDC into the steadiest vault, in one deposit',
    cadence: 'check the vault\'s strike and expiry once a week',
    claim: 'the vault\'s own rewards page',
    risk: 'a sold option can be exercised against the vault, so read the strike before depositing',
    extra: 'a smaller deposit in a second vault the protocol runs',
  },
  Synthetics: {
    setup: 'mint the protocol\'s synthetic asset against the collateral it accepts, or deposit into its pool',
    mix: 'the accepted collateral, with a buffer above the minimum ratio',
    cadence: 'check the ratio and the rewards once a week, and adjust a small amount',
    claim: 'the protocol\'s own rewards page for minters',
    risk: 'a synthetic can depeg from its underlying, so keep the ratio well above the floor',
    extra: 'a small pool deposit if the protocol runs one',
  },
  'Interest Rate Derivatives': {
    setup: 'deposit into the protocol\'s rate market and take one small fixed or floating position',
    mix: 'USDC into the market, capped at what you can leave for the term',
    cadence: 'check the rate and the position once a week',
    claim: 'the protocol\'s own rewards page',
    risk: 'a rate position is a bet on the curve, so size it as one',
    extra: 'a second small position on the other side of the curve',
  },
  'Prediction Market': {
    setup: 'fund the protocol\'s account and place one small position on a liquid market you can judge',
    mix: 'USDC, no more than a tenth of the capital per market',
    cadence: 'place or close one position a week and claim any resolved winnings',
    claim: 'the protocol\'s own rewards page for traders',
    risk: 'a resolved market pays only the winning side, so treat each position as a full loss',
    extra: 'a second small position on a different market',
  },
  'Dual-Token Stablecoin': {
    setup: 'mint or buy the protocol\'s stable token, and stake the volatile token if the protocol pairs them',
    mix: 'USDC into the stable token, with a small stake in the paired token',
    cadence: 'check the peg and the rewards once a week, and rebalance a small amount',
    claim: 'the protocol\'s own rewards page for both tokens',
    risk: 'the dual-token design can break its peg in a run, so keep the stable side only',
    extra: 'a small stability-pool position if the protocol runs one',
  },
  'Algo-Stables': {
    setup: 'mint the protocol\'s algorithmic stable asset against the collateral it accepts',
    mix: 'the accepted collateral, with a buffer above the minimum ratio',
    cadence: 'check the peg and the ratio once a week, and adjust a small amount',
    claim: 'the protocol\'s own rewards page for minters',
    risk: 'algorithmic pegs have failed before, so size the position as a full loss',
    extra: 'a small stability-pool position if the protocol runs one',
  },
  'Stablecoin Issuer': {
    setup: 'mint the protocol\'s stable asset against the collateral it accepts, or deposit into its reserve',
    mix: 'the accepted collateral, with a buffer above the minimum ratio',
    cadence: 'check the peg and the rewards once a week',
    claim: 'the issuer\'s own rewards page for minters',
    risk: 'the issuer holds the reserves, so read the attestations before a large mint',
    extra: 'a small position in the issuer\'s savings product if it has one',
  },
  'Reserve Currency': {
    setup: 'mint the protocol\'s reserve asset against the collateral it accepts',
    mix: 'the accepted collateral, with a buffer above the minimum ratio',
    cadence: 'check the peg and the ratio once a week',
    claim: 'the protocol\'s own rewards page for minters',
    risk: 'a reserve asset depends on its collateral, so read what backs it before minting',
    extra: 'a small position in the protocol\'s savings product if it has one',
  },
  'Stablecoin Wrapper': {
    setup: 'mint or wrap into the protocol\'s stable wrapper and hold the wrapped asset',
    mix: 'USDC wrapped in one transaction, with the gas left over',
    cadence: 'check the wrapper\'s rate and the rewards once a week',
    claim: 'the wrapper\'s own rewards page',
    risk: 'a wrapper adds a contract between you and the stablecoin, so check its audits',
    extra: 'a small unwrap and rewrap once a month to keep the route warm',
  },
  CeDeFi: {
    setup: 'open the protocol\'s account, complete its verification and deposit a stablecoin into its on-chain or custodial product',
    mix: 'USDC in one deposit, kept small until the withdrawal route is proven',
    cadence: 'use the product once a week, or move a small amount between its venues',
    claim: 'the protocol\'s own rewards page inside its account',
    risk: 'a centralised venue can freeze a withdrawal, so test the exit before scaling',
    extra: 'a second, smaller position in another product the venue offers',
  },
  Payments: {
    setup: 'open the protocol\'s payment account and move a small stablecoin balance through it',
    mix: 'USDC, kept small until a withdrawal has cleared',
    cadence: 'send or receive one small payment a week through the protocol',
    claim: 'the protocol\'s own rewards or points page',
    risk: 'a payment rail can hold funds for review, so keep the balance small',
    extra: 'a second corridor or currency the protocol supports',
  },
  'Crypto Card Issuer': {
    setup: 'open the protocol\'s card account, deposit a stablecoin and make one small card payment',
    mix: 'USDC, kept small until a top-up and a withdrawal have both cleared',
    cadence: 'spend or top up a small amount once a week',
    claim: 'the issuer\'s own rewards page inside its account',
    risk: 'card programmes can pause a country or a currency, so keep the balance small',
    extra: 'a second card tier or currency the issuer offers',
  },
  Chain: {
    setup: 'bridge a stablecoin onto the chain, keep the native gas token and make one transaction in its main app',
    mix: 'USDC bridged in one direction, plus the native token for gas',
    cadence: 'make one transaction a week on the chain, or use a lending or dex app it hosts',
    claim: 'the chain\'s own grants or points programme, published on its site',
    risk: 'a young chain can stall or reorg, so bridge only what you would leave there',
    extra: 'a second app on the same chain, with a smaller amount',
  },
  'Token Locker': {
    setup: 'lock a small balance of a token the protocol supports for the shortest available term',
    mix: 'a token you already hold, locked for the shortest term the protocol offers',
    cadence: 'check the lock and the rewards once a week',
    claim: 'the locker\'s own rewards page for locked positions',
    risk: 'a lock cannot be undone early, so lock only what you will not need',
    extra: 'a second, smaller lock with a different term',
  },
  'Governance Incentives': {
    setup: 'deposit into the protocol\'s incentive programme and vote on one proposal with the position',
    mix: 'the asset the programme accepts, in one deposit',
    cadence: 'vote on one proposal a week, or claim and restake the incentives',
    claim: 'the protocol\'s own governance and rewards page',
    risk: 'incentive programmes end on a vote, so do not count the yield as permanent',
    extra: 'a second, smaller position in another programme the protocol runs',
  },
  Launchpad: {
    setup: 'open the protocol\'s launch account and take one small allocation in a sale it lists',
    mix: 'USDC, no more than a tenth of the capital per sale',
    cadence: 'check the sale calendar once a week and take one allocation',
    claim: 'the launchpad\'s own claim page after a sale settles',
    risk: 'a sale can be oversubscribed or refunded, so never commit more than you can leave idle',
    extra: 'a second, smaller allocation in another sale',
  },
  Insurance: {
    setup: 'buy cover on a protocol you already use, for the shortest term the market offers',
    mix: 'the premium only, sized to the position you are covering',
    cadence: 'renew or extend the cover once a month',
    claim: 'the market\'s own rewards page for cover buyers and sellers',
    risk: 'cover pays only on the terms it states, so read the trigger before buying',
    extra: 'a small underwriting position on a market you understand',
  },
  Privacy: {
    setup: 'deposit a stablecoin into the protocol\'s shielded pool and make one shielded transfer',
    mix: 'USDC, kept small until a withdrawal has cleared',
    cadence: 'make one shielded transfer a week to keep the route active',
    claim: 'the protocol\'s own rewards page for shielded volume',
    risk: 'shielded pools carry compliance and contract risk, so keep the balance small',
    extra: 'a second, smaller deposit on another supported chain',
  },
  'AI Agents': {
    setup: 'deposit into the protocol\'s agent vault, or stake the token it uses to pay for agent work',
    mix: 'USDC into the vault, or the payment token the protocol accepts',
    cadence: 'run or fund one agent task a week through the protocol',
    claim: 'the protocol\'s own points page for users and stakers',
    risk: 'agent strategies are new code, so size the position as a full loss',
    extra: 'a second, smaller position in another agent the protocol lists',
  },
  'Decentralized AI': {
    setup: 'stake or deposit into the protocol\'s compute or model market and keep the receipt',
    mix: 'the payment token the protocol accepts, or USDC if it takes it',
    cadence: 'run one task or add a small amount once a week',
    claim: 'the protocol\'s own points page for providers and users',
    risk: 'compute markets are early, so keep the position small and the receipt visible',
    extra: 'a second, smaller position in another market the protocol runs',
  },
  'NFT Marketplace': {
    setup: 'connect the wallet, list one low-value item and make one small purchase on the marketplace',
    mix: 'a small amount of the chain\'s native token for gas and one modest purchase',
    cadence: 'make one trade a week on the marketplace',
    claim: 'the marketplace\'s own rewards page for traders',
    risk: 'illiquid items are hard to exit, so buy only what you would keep',
    extra: 'a second, smaller trade in a different collection',
  },
  'OTC Marketplace': {
    setup: 'open the protocol\'s desk, post one small order and settle it with a counterparty',
    mix: 'USDC for one small settlement, with the gas left over',
    cadence: 'post or settle one small order a week',
    claim: 'the desk\'s own rewards page for traders',
    risk: 'an OTC settlement depends on the counterparty, so use the protocol\'s escrow',
    extra: 'a second, smaller order in a different pair',
  },
};

/** The generic plan for a category the map does not name. */
const GENERIC_PLAN: PlanSpec = {
  setup: 'deposit a stablecoin into the protocol\'s main product on its largest chain and keep the position open',
  mix: 'USDC in one deposit, with a reserve for gas',
  cadence: 'make one qualifying action a week, such as a deposit, a withdrawal or a claim',
  claim: 'the protocol\'s own rewards or points page, published on its site',
  risk: 'the product is new to you, so read what it holds before the deposit',
  extra: 'a second, smaller position in another product the protocol runs',
};

/** The plan spec for a category, falling back to the generic one. */
function planFor(category: string | null): PlanSpec {
  return (category !== null ? PLANS[category] : undefined) ?? GENERIC_PLAN;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from the
 * protocol's own record (category, chains, TVL, age) and never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const gas = gasOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const plan = planFor(p.category);
  const cat = p.category ?? 'this category';
  const chains = p.chains.length > 0 ? p.chains.join(', ') : 'no chain listed';
  const maturity = Math.round(
    (MODEL.maturity_floor + (Math.min(Math.max(age ?? MODEL.unknown_age_days, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range) * 100,
  );
  return [
    {
      text: `Create a fresh wallet on ${chain} that holds only the $${capital} you plan to farm, and keep its seed phrase offline; never reuse a wallet that holds long-term funds.`,
      cost: `${gas} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: `On ${chain}, ${plan.setup}. ${p.name} is a ${cat} protocol with $${Math.round(p.tvl_usd / 1e6)}M of TVL, listed on ${chains}.`,
      cost: `$${capital} of capital plus ${gas} of gas`,
      time: '15-20 minutes to set up',
    },
    {
      text: `Set the size so that: ${plan.mix}; write the exact amounts in a note so the plan can be repeated or unwound.`,
      cost: `the $${capital} stays in the position`,
      time: '10 minutes',
    },
    {
      text: `Then ${plan.cadence}; weekly activity is what a points snapshot can see, and one large deposit on the last day is what it misses.`,
      cost: `${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text:
        age === null
          ? `Hold the position at least ${hold} days so the activity lands in more than one points snapshot; the protocol records no listing date, so the plan assumes the longer window.`
          : `Hold the position at least ${hold} days so the activity lands in more than one points snapshot; its ${age}-day listing age sets the maturity multiplier at ${maturity}%.`,
      cost: `the $${capital} is locked for ${hold} days`,
      time: `${hold} days`,
    },
    {
      text: `Add a second, smaller position — ${plan.extra} — so one pool's outage, or a range that stops earning, does not end the whole farm.`,
      cost: `about a third of the first position, so $${Math.max(10, Math.round(capital / 3))}`,
      time: '15 minutes',
    },
    {
      text: `Claim only from ${plan.claim}, and never pay a fee to claim; ${plan.risk}.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates, the amounts and every transaction in a farm log, so the position can be repeated, scaled or unwound without guessing.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/* ------------------------------------------------------------------ the board */

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const table = buildPeerTable(snapshot.protocols, model);
  const watch = new Set(snapshot.watchlist);
  const index = bySlug(snapshot.protocols);

  // The board's population: every pre-token protocol the snapshot carries that the rankable rule keeps,
  // which is the watchlist plus every other protocol still to come. The watchlist is the floor, not the
  // ceiling, so nothing rankable is dropped for being small or unnamed by the house.
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!isRankable(p) || chosen.has(p.slug)) continue;
    chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const stat = table.get(p.category ?? '') ?? peerStat('', () => [], model);
    const { implied, model: m } = scoreProtocol(p, snapshot.as_of, stat, model);
    return { p, implied, m };
  });
  scored.sort(
    (a, b) =>
      b.implied - a.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );

  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.m.age_days,
    listed_at: s.p.listed_at,
    token_status: 'pre-token',
    watchlisted: watch.has(s.p.slug),
    implied_value_usd: s.implied,
    model: s.m,
    farm_steps: farmSteps(s.p, s.m.age_days).map(stepText),
  }));
}

/** The protocols whose token already trades, by market cap, for the dashboard's live market view. */
export function liveRows(snapshot: Snapshot, limit = 40): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watch = new Set(snapshot.watchlist);
  const table = buildPeerTable(snapshot.protocols, model);
  const peers = [...table.values()].sort((a, b) => b.multiple - a.multiple || (a.category < b.category ? -1 : 1));
  const pretoken = snapshot.protocols.filter(isPreToken);
  const ranked = new Set(board.map((r) => r.slug));
  const excluded: ExcludedRow[] = pretoken
    .filter((p) => !ranked.has(p.slug))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      reason: notRankableReason(p) ?? 'set aside',
    }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    live_total: snapshot.protocols.filter((p) => !isPreToken(p)).length,
    pretoken_total: pretoken.length,
    excluded,
    rows: board,
    live,
    peers,
  };
  return { board, radar };
}

/* ------------------------------------------------------------------ input, checks, output */

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board holds ${board.length} rows, under the gate's 100`;
  if (board.length > 4000) return `the board holds ${board.length} rows, over the gate's 4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (seen.has(r.slug)) return `${r.slug} appears more than once`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value above the gate's ceiling`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
