// Fitting the multiple, from the snapshot itself.
//
// radar-2 priced a pre-token protocol as
//
//     tvl x peerMultiple x growthMultiplier x maturityMultiplier
//
// where the four constants (growth weight 0.5, growth clamp, a 1095-day maturity ramp, the peer
// borrow rule) were chosen by hand. The snapshot's own live tokens say that arithmetic is wrong, and
// this file replaces it with coefficients that were measured rather than picked.
//
// The target. For a protocol whose token already trades, the market has already answered the
// question this radar asks: its multiple is mcap / tvl. So the training set is every live protocol
// in the snapshot (128 of them), and the target is log10(mcap / tvl).
//
// The features. Four candidates, and the calibration reports what each one was actually worth:
//
//     log10 TVL             corr -0.409   the strongest single signal, negative
//     7d change             corr -0.149   weak
//     log10 age             corr -0.003   nothing at all
//     log10 category median corr +0.236   real, but largely redundant with TVL
//
// Leave-one-out decided which survive. Age and 7d momentum were dropped outright: both made
// out-of-sample error worse, and a feature that does not predict is not a feature, it is noise with
// a story attached. Category is kept despite costing a little accuracy, because the board has to
// separate two protocols that share a TVL, and TVL alone cannot. That cost is printed, not hidden.
//
// Everything here is deterministic: no sampling, no random init, fixed solve order, so two builds on
// the same snapshot produce the same bytes. The build's run-twice gate depends on that.

/** Ridge strength. Small enough to barely move the fit, large enough to keep the solve stable. */
export const LAMBDA = 1.0;

/** The features the model keeps, in coefficient order. */
export const FEATURE_NAMES = ['log10 TVL', 'log10 category median'] as const;

/** One training row: a protocol whose token already trades. */
export interface FitSample {
  /** Current TVL, USD. Always > 0 for a training row. */
  tvl: number;
  /** The observed multiple, mcap / tvl. Always > 0 for a training row. */
  multiple: number;
  /** 7d change, in percent, as the snapshot carries it. May be null. */
  growth: number | null;
  /** Days since listing. May be null. */
  age: number | null;
  /** Median multiple of the *other* live protocols in this category, or null when none. */
  categoryMedian: number | null;
}

/** The fitted model: two coefficients plus the standardization they were fitted in. */
export interface FitModel {
  /** Coefficients in standardized space: [intercept, log10 tvl, log10 category median]. */
  coefficients: number[];
  /** The mean of each non-intercept feature, in raw units. */
  center: number[];
  /** The standard deviation of each non-intercept feature, in raw units. */
  scale: number[];
  /** Residual quantiles in log10 space: the band an 80% interval is built from. */
  bandLow: number;
  bandHigh: number;
  /** The residual standard deviation in log10 space. */
  residualSd: number;
  /** Training rows used. */
  rows: number;
  /** Ridge strength. */
  lambda: number;
}

/** One specification's out-of-sample score. */
export interface Ablation {
  /** What the specification is, in words a reader can check against the code. */
  spec: string;
  /** How many features it used. */
  features: number;
  /** Median multiplicative error, leave-one-out. 1.0 is perfect. */
  median: number;
  within2: number;
  within3: number;
  within10: number;
  p90: number;
}

/** What the fit is worth, measured out of sample. */
export interface Calibration {
  rows: number;
  /** The specification that shipped. */
  chosen: string;
  /** Every specification tried, so the choice is auditable rather than asserted. */
  ablation: Ablation[];
  /** Share of held-out residuals that landed inside the printed band. */
  bandCoverage: number;
  bandLow: number;
  bandHigh: number;
  /** Pearson r of each candidate feature against log10 multiple. */
  correlations: { feature: string; r: number }[];
  lambda: number;
}

const log10 = (n: number): number => Math.log10(n);

/** Candidate specifications, cheapest first. Each is tried and scored by leave-one-out. */
const SPECS: { spec: string; feats: ('tvl' | 'growth' | 'age' | 'catmed')[] }[] = [
  { spec: 'log10 TVL only', feats: ['tvl'] },
  { spec: 'log10 TVL + log10 category median', feats: ['tvl', 'catmed'] },
  { spec: 'log10 TVL + 7d change + log10 category median', feats: ['tvl', 'growth', 'catmed'] },
  { spec: 'log10 TVL + 7d change + log10 age + log10 category median', feats: ['tvl', 'growth', 'age', 'catmed'] },
];

/** The specification the model ships with. */
const CHOSEN = 'log10 TVL + log10 category median';

const GROWTH_CLAMP = 100;
const AGE_FLOOR_DAYS = 1;
const AGE_CEIL_DAYS = 3650;

/** The kept features of a sample, in raw units. */
function keptFeatures(s: FitSample): number[] {
  const cat = s.categoryMedian !== null && s.categoryMedian > 0 ? log10(s.categoryMedian) : 0;
  return [log10(Math.max(s.tvl, 1)), cat];
}

/** Any candidate feature of a sample, in raw units, for the ablation runs. */
function feature(s: FitSample, name: 'tvl' | 'growth' | 'age' | 'catmed'): number {
  switch (name) {
    case 'tvl':
      return log10(Math.max(s.tvl, 1));
    case 'growth': {
      const g = Math.min(GROWTH_CLAMP, Math.max(-GROWTH_CLAMP, s.growth ?? 0));
      return g / 100;
    }
    case 'age': {
      const a = Math.min(AGE_CEIL_DAYS, Math.max(AGE_FLOOR_DAYS, s.age ?? 365));
      return log10(a);
    }
    case 'catmed':
      return s.categoryMedian !== null && s.categoryMedian > 0 ? log10(s.categoryMedian) : 0;
  }
}

/** Standardize one raw feature vector against a center and scale. */
function standardize(raw: number[], center: number[], scale: number[]): number[] {
  return [1, ...raw.map((v, i) => (scale[i]! === 0 ? 0 : (v - center[i]!) / scale[i]!))];
}

/**
 * Solve `A x = b` by Gaussian elimination with partial pivoting.
 *
 * Deterministic by construction: the pivot search takes the first maximum in a fixed order, and
 * the elimination visits rows and columns in a fixed order. Two runs on the same input produce the
 * same bits, which the build's run-twice gate requires.
 */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
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

/** Ridge fit on a design matrix: returns coefficients in standardized space. */
function ridge(X: number[][], y: number[], lambda: number): number[] {
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const row = X[i]!;
    for (let a = 0; a < k; a++) {
      b[a] = b[a]! + row[a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c] = A[a]![c]! + row[a]! * row[c]!;
    }
  }
  for (let a = 1; a < k; a++) A[a]![a] = A[a]![a]! + lambda; // never penalize the intercept
  return solve(A, b);
}

const mean = (v: number[]): number => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);
const sd = (v: number[]): number => {
  if (v.length < 2) return 1;
  const mu = mean(v);
  const varSum = v.reduce((acc, x) => acc + (x - mu) ** 2, 0) / (v.length - 1);
  const s = Math.sqrt(varSum);
  return s === 0 ? 1 : s;
};

/** Pearson correlation, or 0 when either side has no variance. */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** The quantile of a sorted array at q, by linear interpolation between neighbours. */
function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Leave-one-out predictions for one specification.
 *
 * For each row: refit on the other n-1 rows, predict the held-out row, record the multiplicative
 * error. Refitting is what makes this honest — a row is never scored by a model that saw it.
 */
function looErrors(samples: FitSample[], feats: ('tvl' | 'growth' | 'age' | 'catmed')[]): { errs: number[]; residuals: number[] } {
  const y = samples.map((s) => log10(s.multiple));
  const raw = samples.map((s) => feats.map((f) => feature(s, f)));
  const errs: number[] = [];
  const residuals: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const trainRaw = raw.filter((_, j) => j !== i);
    const trainY = y.filter((_, j) => j !== i);
    if (trainRaw.length < feats.length + 2) continue;
    const center = feats.map((_, f) => mean(trainRaw.map((r) => r[f]!)));
    const scale = feats.map((_, f) => sd(trainRaw.map((r) => r[f]!)));
    const X = trainRaw.map((r) => standardize(r, center, scale));
    const coef = ridge(X, trainY, LAMBDA);
    const z = standardize(raw[i]!, center, scale);
    let pred = 0;
    for (let k = 0; k < coef.length; k++) pred += coef[k]! * z[k]!;
    const residual = pred - y[i]!;
    residuals.push(residual);
    const factor = 10 ** residual;
    errs.push(factor >= 1 ? factor : 1 / factor);
  }
  return { errs, residuals };
}

/** Summarize a list of multiplicative errors. */
function summarize(errs: number[]): Omit<Ablation, 'spec' | 'features'> {
  const sorted = [...errs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { median: 0, within2: 0, within3: 0, within10: 0, p90: 0 };
  return {
    median: quantile(sorted, 0.5),
    within2: sorted.filter((e) => e <= 2).length / n,
    within3: sorted.filter((e) => e <= 3).length / n,
    within10: sorted.filter((e) => e <= 10).length / n,
    p90: quantile(sorted, 0.9),
  };
}

/**
 * Fit the multiple, and measure it.
 *
 * Returns the shipped model plus a calibration block that carries the full ablation table: every
 * specification tried, scored the same way, so a reader can see why two features survived and two
 * were dropped rather than taking it on faith.
 */
export function fitMultiple(samples: FitSample[]): { model: FitModel; calibration: Calibration } {
  const usable = samples.filter((s) => s.multiple > 0 && Number.isFinite(s.multiple));
  const y = usable.map((s) => log10(s.multiple));

  // The ablation: score every candidate specification out of sample, plus the two baselines a reader
  // would want to beat before believing any of this. A fit that cannot beat a flat multiple and a
  // bare category median has earned nothing.
  const flatErrs = usable.map((s) => {
    const r = 0.25 / s.multiple;
    return r >= 1 ? r : 1 / r;
  });
  const catErrs = usable.map((s) => {
    if (s.categoryMedian === null || s.categoryMedian <= 0) return 1;
    const r = s.categoryMedian / s.multiple;
    return r >= 1 ? r : 1 / r;
  });
  const ablation: Ablation[] = [
    { spec: 'baseline: flat 0.25× for every protocol', features: 0, ...summarize(flatErrs) },
    { spec: 'baseline: category median multiple', features: 0, ...summarize(catErrs) },
    ...SPECS.map(({ spec, feats }) => {
      const { errs } = looErrors(usable, feats);
      return { spec, features: feats.length, ...summarize(errs) };
    }),
  ];

  // The shipped fit: full-data coefficients for the chosen specification.
  const chosen = SPECS.find((s) => s.spec === CHOSEN) ?? SPECS[1]!;
  const rawKept = usable.map((s) => keptFeatures(s));
  const center = chosen.feats.map((_, f) => mean(rawKept.map((r) => r[f]!)));
  const scale = chosen.feats.map((_, f) => sd(rawKept.map((r) => r[f]!)));
  const X = rawKept.map((r) => standardize(r, center, scale));
  const coefficients = ridge(X, y, LAMBDA);

  // The band: quantiles of the leave-one-out residuals in log10 space.
  const { residuals } = looErrors(usable, chosen.feats);
  const sortedResiduals = [...residuals].sort((a, b) => a - b);
  const bandLow = quantile(sortedResiduals, 0.1);
  const bandHigh = quantile(sortedResiduals, 0.9);
  const covered = residuals.filter((r) => r >= bandLow && r <= bandHigh).length;
  const bandCoverage = residuals.length === 0 ? 0 : covered / residuals.length;
  const residualSd = Math.sqrt(residuals.reduce((acc, r) => acc + r * r, 0) / Math.max(1, residuals.length));

  // What each candidate feature correlates with, printed so the drops are visible.
  const rawAll = usable.map((s) => ({
    tvl: feature(s, 'tvl'),
    growth: feature(s, 'growth'),
    age: feature(s, 'age'),
    catmed: feature(s, 'catmed'),
  }));
  const correlations = [
    { feature: 'log10 TVL', r: pearson(rawAll.map((r) => r.tvl), y) },
    { feature: '7d change', r: pearson(rawAll.map((r) => r.growth), y) },
    { feature: 'log10 age', r: pearson(rawAll.map((r) => r.age), y) },
    { feature: 'log10 category median', r: pearson(rawAll.map((r) => r.catmed), y) },
  ];

  return {
    model: { coefficients, center, scale, bandLow, bandHigh, residualSd, rows: usable.length, lambda: LAMBDA },
    calibration: {
      rows: usable.length,
      chosen: CHOSEN,
      ablation,
      bandCoverage,
      bandLow,
      bandHigh,
      correlations,
      lambda: LAMBDA,
    },
  };
}

/** The multiple the model predicts for one sample, as a factor. */
export function predictMultiple(model: FitModel, s: FitSample): number {
  const z = standardize(keptFeatures(s), model.center, model.scale);
  let logMult = 0;
  for (let k = 0; k < model.coefficients.length; k++) logMult += model.coefficients[k]! * z[k]!;
  return 10 ** logMult;
}

/**
 * The same prediction, itemised: each feature's raw value, its coefficient, and what it contributed
 * to the log10 multiple. The dashboard prints this so a row's implied value can be checked by hand
 * against the coefficients rather than trusted.
 */
export function explainPrediction(
  model: FitModel,
  s: FitSample,
): { feature: string; value: number; coefficient: number; contribution: number }[] {
  const raw = keptFeatures(s);
  const z = standardize(raw, model.center, model.scale);
  return FEATURE_NAMES.map((name, i) => ({
    feature: name,
    value: raw[i]!,
    coefficient: model.coefficients[i + 1] ?? 0,
    contribution: (model.coefficients[i + 1] ?? 0) * z[i + 1]!,
  }));
}

/** The 80% band around a point estimate, as factors of it. */
export function bandFor(model: FitModel, point: number): { low: number; high: number } {
  return { low: point * 10 ** model.bandLow, high: point * 10 ** model.bandHigh };
}
