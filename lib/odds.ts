// Launch odds: the probability a protocol ever records a token, fitted from the snapshot.
//
// radar-3 priced a pre-token protocol as TVL x fittedMultiple. That number answers a conditional
// question — "what would this be worth IF a token existed" — and then quietly treats it as if the
// token certainly would. The board's top rows were protocols whose multiple was high and whose odds
// were never asked about. This file asks.
//
// The target. Every protocol in the snapshot either records a token or does not: `traded` is 1 when
// the record carries a gecko id or a symbol, 0 otherwise. That is the outcome we model:
//
//     P(traded | log10 TVL, 7d change, log10 age, age x TVL, age missing)
//
// The features, and what each was worth out of sample (5-fold, see the ablation table):
//
//     log10 age            +0.28 corr   the strongest signal, and positive: older protocols are
//                                        more likely to have a token, not less
//     7d change            -0.05 corr   weak, and negative: a collapsing TVL predicts a token
//     log10 TVL            +0.06 corr   weak on its own
//     age x TVL                        real: TVL only predicts a token among mature protocols
//     age missing                      real, and large: records without a listing date are 79%
//                                        traded against a 51% base rate. The absence is data.
//
// Two things this model is careful about, because both would flatter it:
//
// 1. No in-sample scoring. Every protocol's printed odds are its OUT-OF-FOLD prediction: the fold
//    that produced it was fitted without it. A protocol is never priced by a model that saw its
//    answer. This costs a little accuracy and buys the whole point.
//
// 2. Imputation is per-fold. Age is missing for 113 of 758 records; the category median that fills
//    it is computed from the training rows of that fold only, never from the held-out row.
//
// The honest caveat, printed on the dashboard rather than buried here: a protocol that has not
// launched yet is recorded as traded = 0 today, so the negative class is right-censored. The odds
// this model reports are therefore a floor on the eventual launch rate, not an estimate of it.
// They rank protocols correctly — that is what AUC measures — but the level is conservative.
//
// Everything is deterministic: fixed fold assignment by slug hash, fixed solve order, no sampling.
// Two builds on one snapshot produce the same bytes, which the run-twice gate depends on.

/** Ridge strength for the logistic solve. Small next to the Hessian, large enough to keep it stable. */
export const ODDS_LAMBDA = 1.0;

/** Folds for the out-of-sample evaluation. */
export const ODDS_FOLDS = 5;

/** Age floor and ceiling, in days, before the log. */
const AGE_FLOOR_DAYS = 1;
const AGE_CEIL_DAYS = 3650;

/** 7d change clamp, in percent. */
const GROWTH_CLAMP = 100;

/** One protocol's record, as the odds model sees it. */
export interface OddsSample {
  slug: string;
  /** 1 when the protocol records a token, 0 when it does not. */
  traded: 0 | 1;
  tvl: number;
  /** 7d change, percent. May be null. */
  growth: number | null;
  /** Days since the protocol was listed. May be null — and null is itself a feature. */
  age: number | null;
  category: string | null;
}

/** The imputation table: what fills a missing age, computed from training rows only. */
export interface OddsImpute {
  byCategory: Record<string, number>;
  global: number;
}

/** The fitted odds model. */
export interface OddsModel {
  /** Coefficients in standardized space: [intercept, ...features]. */
  coefficients: number[];
  /** Feature names, in coefficient order after the intercept. */
  features: string[];
  center: number[];
  scale: number[];
  /** The imputation the fit used. */
  impute: OddsImpute;
  rows: number;
  /** Share of training rows that record a token. */
  baseRate: number;
  lambda: number;
}

/** One candidate specification, scored out of sample. */
export interface OddsAblation {
  spec: string;
  features: number;
  /** Area under the ROC curve. 0.5 is a coin flip. */
  auc: number;
  /** Brier score: mean squared error on the probability. Lower is better. */
  brier: number;
  /** How much better than always predicting the base rate, in Brier points. */
  gain: number;
}

/** One decile of the out-of-sample predictions: what was predicted, what happened. */
export interface OddsDecile {
  n: number;
  predicted: number;
  actual: number;
}

/** What the odds model is worth, measured out of sample. */
export interface OddsCalibration {
  rows: number;
  baseRate: number;
  /** Out-of-fold AUC of the shipped specification. */
  auc: number;
  /** Out-of-fold Brier of the shipped specification. */
  brier: number;
  /** Brier of a model that always predicts the base rate. */
  brierBase: number;
  /** Largest gap between predicted and actual in any decile. */
  maxCalibrationError: number;
  deciles: OddsDecile[];
  /** Every specification tried, so the choice is auditable rather than asserted. */
  ablation: OddsAblation[];
  chosen: string;
}

const log10 = (n: number): number => Math.log10(Math.max(n, 1e-12));

const clampAge = (a: number): number => Math.min(AGE_CEIL_DAYS, Math.max(AGE_FLOOR_DAYS, a));

const clampGrowth = (g: number): number => Math.min(GROWTH_CLAMP, Math.max(-GROWTH_CLAMP, g));

/** Sigmoid, clamped so the exponential cannot overflow. */
function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

/** Median of a list, or null when empty. Sorts a copy so the caller's array is untouched. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The imputation table for a set of training rows: category median age, else the global median. */
export function buildImpute(samples: OddsSample[]): OddsImpute {
  const buckets = new Map<string, number[]>();
  const all: number[] = [];
  for (const s of samples) {
    if (s.age === null) continue;
    const key = s.category ?? '';
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [s.age]);
    else bucket.push(s.age);
    all.push(s.age);
  }
  const byCategory: Record<string, number> = {};
  for (const [key, ages] of buckets) {
    // A category median from fewer than three records is not a median, it is one protocol's age.
    if (ages.length < 3) continue;
    const m = median(ages);
    if (m !== null) byCategory[key] = m;
  }
  const global = median(all) ?? 365;
  return { byCategory, global };
}

/** The age a sample is treated as having, plus whether that age was imputed. */
function resolvedAge(s: OddsSample, impute: OddsImpute): { age: number; missing: number } {
  if (s.age !== null) return { age: clampAge(s.age), missing: 0 };
  const guess = impute.byCategory[s.category ?? ''];
  return { age: clampAge(guess === undefined ? impute.global : guess), missing: 1 };
}

/** Every feature specification the ablation tries, cheapest first. */
const ODDS_SPECS: { spec: string; feats: OddsFeature[] }[] = [
  { spec: 'baseline: the base rate for every protocol', feats: [] },
  { spec: 'log10 age only', feats: ['age'] },
  { spec: 'log10 TVL + 7d change + log10 age', feats: ['tvl', 'growth', 'age'] },
  { spec: 'log10 TVL + 7d change + log10 age + log10 age^2', feats: ['tvl', 'growth', 'age', 'age2'] },
  {
    spec: 'log10 TVL + 7d change + log10 age + log10 age^2 + age x TVL',
    feats: ['tvl', 'growth', 'age', 'age2', 'ageTvl'],
  },
  {
    spec: 'log10 TVL + 7d change + log10 age + log10 age^2 + age x TVL + age missing',
    feats: ['tvl', 'growth', 'age', 'age2', 'ageTvl', 'ageMissing'],
  },
];

/** The specification the model ships with. */
const ODDS_CHOSEN =
  'log10 TVL + 7d change + log10 age + log10 age^2 + age x TVL + age missing';

type OddsFeature = 'tvl' | 'growth' | 'age' | 'age2' | 'ageTvl' | 'ageMissing';

/** The model's name for each feature, for the coefficient table the dashboard prints. */
const ODDS_FEATURE_NAMES: Record<OddsFeature, string> = {
  tvl: 'log10 TVL',
  growth: '7d change / 100',
  age: 'log10 age',
  age2: 'log10 age^2',
  ageTvl: 'log10 age x log10 TVL',
  ageMissing: 'age missing',
};

/** One feature of a sample, in raw units. */
function oddsFeature(s: OddsSample, f: OddsFeature, impute: OddsImpute): number {
  const { age, missing } = resolvedAge(s, impute);
  const la = log10(age);
  const lt = log10(Math.max(s.tvl, 1));
  switch (f) {
    case 'tvl':
      return lt;
    case 'growth':
      return clampGrowth(s.growth ?? 0) / 100;
    case 'age':
      return la;
    case 'age2':
      return la * la;
    case 'ageTvl':
      return la * lt;
    case 'ageMissing':
      return missing;
  }
}

/** Raw feature vector for a specification. */
function rawFeatures(s: OddsSample, feats: OddsFeature[], impute: OddsImpute): number[] {
  return feats.map((f) => oddsFeature(s, f, impute));
}

const mean = (v: number[]): number => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);

const sd = (v: number[]): number => {
  if (v.length < 2) return 1;
  const mu = mean(v);
  const s = Math.sqrt(v.reduce((acc, x) => acc + (x - mu) ** 2, 0) / (v.length - 1));
  return s === 0 ? 1 : s;
};

/** Standardize a raw vector against a center and scale, with a leading intercept. */
function standardize(raw: number[], center: number[], scale: number[]): number[] {
  return [1, ...raw.map((v, i) => (scale[i]! === 0 ? 0 : (v - center[i]!) / scale[i]!))];
}

/**
 * Solve `A x = b` by Gaussian elimination with partial pivoting.
 *
 * Deterministic: the pivot search takes the first maximum in a fixed order and elimination visits
 * rows and columns in a fixed order, so two runs on the same input produce the same bits.
 */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    }
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
    }
    const d = m[col]![col]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = m[row]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[row]![c] = m[row]![c]! - f * m[col]![c]!;
    }
  }
  return m.map((row, i) => {
    const d = row[i]!;
    return Math.abs(d) < 1e-12 ? 0 : row[n]! / d;
  });
}

/**
 * Fit a logistic regression by iteratively reweighted least squares.
 *
 * IRLS rather than gradient descent: it converges in about ten steps on this data, where plain
 * descent needed hundreds, and it has no learning rate to tune or to get wrong. Ridge is added to
 * every coefficient except the intercept, matching the multiple fit.
 */
function fitLogistic(X: number[][], y: number[], lambda: number): number[] {
  const k = X[0]!.length;
  let coef = new Array<number>(k).fill(0);
  for (let iter = 0; iter < 60; iter++) {
    const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const rhs = new Array<number>(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const row = X[i]!;
      let eta = 0;
      for (let a = 0; a < k; a++) eta += coef[a]! * row[a]!;
      const p = sigmoid(eta);
      // Clamp the working weight: a saturated point carries no information and would blow up the solve.
      const w = Math.max(p * (1 - p), 1e-6);
      const z = eta + (y[i]! - p) / w;
      for (let a = 0; a < k; a++) {
        rhs[a] = rhs[a]! + w * row[a]! * z;
        for (let c = 0; c < k; c++) A[a]![c] = A[a]![c]! + w * row[a]! * row[c]!;
      }
    }
    for (let a = 1; a < k; a++) A[a]![a] = A[a]![a]! + lambda; // never penalize the intercept
    const next = solve(A, rhs);
    let delta = 0;
    for (let a = 0; a < k; a++) delta = Math.max(delta, Math.abs(next[a]! - coef[a]!));
    coef = next;
    if (delta < 1e-10) break;
  }
  return coef;
}

/** A deterministic fold index for a slug: FNV-1a, so the split never moves between builds. */
function foldOf(slug: string, folds: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % folds;
}

/** Predict a probability from a fitted model and one sample. */
export function predictOdds(model: OddsModel, s: OddsSample): number {
  const raw = model.features.map((name) => oddsFeature(s, name as OddsFeature, model.impute));
  const z = standardize(raw, model.center, model.scale);
  let eta = 0;
  for (let a = 0; a < z.length; a++) eta += model.coefficients[a]! * z[a]!;
  return sigmoid(eta);
}

/** Area under the ROC curve, by direct pair counting. Ties count half. */
function aucOf(scores: number[], labels: number[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (labels[i] === 1) pos.push(scores[i]!);
    else neg.push(scores[i]!);
  }
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

/** Mean squared error on a probability. */
function brierOf(scores: number[], labels: number[]): number {
  let sum = 0;
  for (let i = 0; i < scores.length; i++) sum += (scores[i]! - labels[i]!) ** 2;
  return scores.length === 0 ? 0 : sum / scores.length;
}

/**
 * Out-of-fold predictions for one specification.
 *
 * Each fold is fitted on the other folds and prices the rows it never saw. Imputation is rebuilt
 * inside each fold from training rows only, so the held-out row cannot leak its own age.
 */
function outOfFold(
  samples: OddsSample[],
  feats: OddsFeature[],
  folds: number,
  lambda: number,
): { scores: number[]; labels: number[] } {
  const scores = new Array<number>(samples.length).fill(0.5);
  const labels = samples.map((s) => s.traded);
  const foldIndex = samples.map((s) => foldOf(s.slug, folds));
  for (let f = 0; f < folds; f++) {
    const train: OddsSample[] = [];
    const testIdx: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (foldIndex[i] === f) testIdx.push(i);
      else train.push(samples[i]!);
    }
    if (testIdx.length === 0 || train.length <= feats.length + 2) continue;
    const impute = buildImpute(train);
    const rawTrain = train.map((s) => rawFeatures(s, feats, impute));
    const center = feats.map((_, j) => mean(rawTrain.map((r) => r[j]!)));
    const scale = feats.map((_, j) => sd(rawTrain.map((r) => r[j]!)));
    const X = rawTrain.map((r) => standardize(r, center, scale));
    const y = train.map((s) => s.traded);
    const coef = feats.length === 0 ? [] : fitLogistic(X, y, lambda);
    for (const i of testIdx) {
      if (feats.length === 0) {
        scores[i] = mean(y);
        continue;
      }
      const z = standardize(rawFeatures(samples[i]!, feats, impute), center, scale);
      let eta = 0;
      for (let a = 0; a < z.length; a++) eta += coef[a]! * z[a]!;
      scores[i] = sigmoid(eta);
    }
  }
  return { scores, labels };
}

/** Decile table: sort by prediction, cut into ten, compare predicted against actual. */
function deciles(scores: number[], labels: number[]): OddsDecile[] {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]! || (a < b ? -1 : 1));
  const out: OddsDecile[] = [];
  for (let d = 0; d < 10; d++) {
    const from = Math.floor((d * idx.length) / 10);
    const to = Math.floor(((d + 1) * idx.length) / 10);
    if (to <= from) continue;
    let ps = 0;
    let ls = 0;
    for (let i = from; i < to; i++) {
      ps += scores[idx[i]!]!;
      ls += labels[idx[i]!]!;
    }
    const n = to - from;
    out.push({ n, predicted: ps / n, actual: ls / n });
  }
  return out;
}

/**
 * Fit the launch-odds model and measure it.
 *
 * Returns the shipped model, the out-of-fold probability for every protocol (which is what the
 * board prints — never the in-sample value), and a calibration block carrying the whole ablation
 * ladder so the specification choice can be checked rather than trusted.
 */
export function fitOdds(samples: OddsSample[]): {
  model: OddsModel;
  calibration: OddsCalibration;
  /** Out-of-fold launch probability, keyed by slug. */
  odds: Map<string, number>;
} {
  const usable = samples.filter((s) => Number.isFinite(s.tvl) && s.tvl > 0);
  const labels = usable.map((s) => s.traded);
  const baseRate = mean(labels);

  // Score every candidate out of sample, plus the base-rate baseline that a real model must beat.
  const ablation: OddsAblation[] = ODDS_SPECS.map(({ spec, feats }) => {
    const { scores, labels: ys } = outOfFold(usable, feats, ODDS_FOLDS, ODDS_LAMBDA);
    const brier = brierOf(scores, ys);
    return {
      spec,
      features: feats.length,
      auc: aucOf(scores, ys),
      brier,
      gain: brierOf(new Array(ys.length).fill(baseRate), ys) - brier,
    };
  });

  const chosenFeats = ODDS_SPECS.find((s) => s.spec === ODDS_CHOSEN)?.feats ?? [];
  const { scores, labels: ys } = outOfFold(usable, chosenFeats, ODDS_FOLDS, ODDS_LAMBDA);
  const brierBase = brierOf(new Array(ys.length).fill(baseRate), ys);
  const dec = deciles(scores, ys);
  const maxErr = dec.reduce((m, d) => Math.max(m, Math.abs(d.actual - d.predicted)), 0);

  // The shipped model, fitted on every row, for the coefficients the dashboard prints.
  const impute = buildImpute(usable);
  const rawAll = usable.map((s) => rawFeatures(s, chosenFeats, impute));
  const center = chosenFeats.map((_, j) => mean(rawAll.map((r) => r[j]!)));
  const scale = chosenFeats.map((_, j) => sd(rawAll.map((r) => r[j]!)));
  const X = rawAll.map((r) => standardize(r, center, scale));
  const coefficients = chosenFeats.length === 0 ? [0] : fitLogistic(X, labels, ODDS_LAMBDA);

  const model: OddsModel = {
    coefficients,
    features: chosenFeats.map((f) => ODDS_FEATURE_NAMES[f]),
    center,
    scale,
    impute,
    rows: usable.length,
    baseRate,
    lambda: ODDS_LAMBDA,
  };

  const odds = new Map<string, number>();
  for (let i = 0; i < usable.length; i++) odds.set(usable[i]!.slug, scores[i]!);

  return {
    model,
    calibration: {
      rows: usable.length,
      baseRate,
      auc: aucOf(scores, ys),
      brier: brierOf(scores, ys),
      brierBase,
      maxCalibrationError: maxErr,
      deciles: dec,
      ablation,
      chosen: ODDS_CHOSEN,
    },
    odds,
  };
}
