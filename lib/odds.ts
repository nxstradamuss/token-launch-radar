/**
 * Token odds: how often protocols in a row's position record a token at all.
 *
 * The value regression prices a protocol's multiple from its TVL and its category's median, and the
 * leave-one-out test says the seven-day move and the age do not improve that price. That test is
 * reported, not hidden. But the two figures are not useless: they are the two that best tell which
 * peers end up recording a token, and a protocol's implied value is the value of a token that may
 * never exist. So they enter here, through the odds, where they do lower the held-out error.
 *
 * The odds are the peers' record, not a forecast: the fit reads which snapshot protocols carry a
 * token today and how long the rest have run without one. It never says a token will launch.
 */

export interface OddsSample {
  /** log10 of TVL, the size a protocol has already reached. */
  log_tvl: number;
  /** log10 of years listed, the time it has run without a token. */
  log_age: number;
  /** The seven-day TVL move, in per cent, already clamped by the caller. */
  growth: number;
  /** 1 when the snapshot records a token for this protocol, 0 while it is still to come. */
  has_token: 0 | 1;
}

export interface OddsModel {
  intercept: number;
  coef: { log_tvl: number; log_age: number; growth: number };
  /** Standardisation the fit was trained under, so a new row is scaled the same way. */
  centre: { log_tvl: number; log_age: number; growth: number };
  scale: { log_tvl: number; log_age: number; growth: number };
  rows: number;
  /** Share of the snapshot's protocols that record a token, the baseline the fit must beat. */
  record_share: number;
  /** Brier score held out ten-fold, and the same for the base rate it must beat. */
  brier: number;
  brier_base: number;
  /** Share of held-out protocols whose outcome the fit called right. */
  called_right: number;
  called_right_base: number;
  /** The same two, walk-forward: the older protocols train the model that prices the newer ones. */
  brier_walk: number;
  called_right_walk: number;
  /** The odds a row may carry, so one thin bucket cannot claim certainty either way. */
  floor: number;
  ceiling: number;
}

const FEATURES = ['log_tvl', 'log_age', 'growth'] as const;
type Feature = (typeof FEATURES)[number];

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[], m: number): number {
  if (xs.length < 2) return 1;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  const s = Math.sqrt(v);
  return s > 1e-9 ? s : 1;
}

function design(s: OddsSample, centre: OddsModel['centre'], scale: OddsModel['scale']): number[] {
  return [
    1,
    (s.log_tvl - centre.log_tvl) / scale.log_tvl,
    (s.log_age - centre.log_age) / scale.log_age,
    (s.growth - centre.growth) / scale.growth,
  ];
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Newton-Raphson on the ridge-penalised log-likelihood. Four parameters, so the Hessian is 4x4 and
 * one exact solve per step is cheaper and steadier than any gradient descent.
 */
function fitLogistic(
  rows: OddsSample[],
  centre: OddsModel['centre'],
  scale: OddsModel['scale'],
  ridge = 1,
): number[] {
  const p = 4;
  let beta = new Array(p).fill(0);
  const X = rows.map((s) => design(s, centre, scale));
  const y = rows.map((s) => s.has_token);
  for (let step = 0; step < 40; step++) {
    const grad = new Array(p).fill(0);
    const hess: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      const xi = X[i];
      const pi = sigmoid(xi.reduce((acc, v, j) => acc + v * beta[j], 0));
      const w = Math.max(pi * (1 - pi), 1e-6);
      const r = y[i] - pi;
      for (let j = 0; j < p; j++) {
        grad[j] += xi[j] * r;
        for (let k = 0; k < p; k++) hess[j][k] += xi[j] * xi[k] * w;
      }
    }
    for (let j = 1; j < p; j++) {
      grad[j] -= ridge * beta[j];
      hess[j][j] += ridge;
    }
    const delta = solve(hess, grad);
    if (delta === null) break;
    let moved = 0;
    for (let j = 0; j < p; j++) {
      beta[j] += delta[j];
      moved += Math.abs(delta[j]);
    }
    if (moved < 1e-8) break;
  }
  return beta;
}

function predictWith(beta: number[], s: OddsSample, centre: OddsModel['centre'], scale: OddsModel['scale']): number {
  const x = design(s, centre, scale);
  return sigmoid(x.reduce((acc, v, j) => acc + v * beta[j], 0));
}

function brierOf(truth: number[], pred: number[]): number {
  if (truth.length === 0) return 0;
  return truth.reduce((a, t, i) => a + (pred[i] - t) ** 2, 0) / truth.length;
}

function shareCalledRight(truth: number[], pred: number[]): number {
  if (truth.length === 0) return 0;
  let right = 0;
  for (let i = 0; i < truth.length; i++) if ((pred[i] >= 0.5 ? 1 : 0) === truth[i]) right++;
  return right / truth.length;
}

/**
 * Fit the odds on the whole snapshot and report two held-out tests: ten-fold, and walk-forward,
 * where the protocols listed earlier train the model that is then asked about the later ones.
 */
export function fitOdds(samples: OddsSample[], floor = 0.3, ceiling = 0.97): OddsModel {
  const usable = samples.filter((s) => Number.isFinite(s.log_tvl) && Number.isFinite(s.log_age) && Number.isFinite(s.growth));
  const centre = {
    log_tvl: mean(usable.map((s) => s.log_tvl)),
    log_age: mean(usable.map((s) => s.log_age)),
    growth: mean(usable.map((s) => s.growth)),
  };
  const scale = {
    log_tvl: stdev(usable.map((s) => s.log_tvl), centre.log_tvl),
    log_age: stdev(usable.map((s) => s.log_age), centre.log_age),
    growth: stdev(usable.map((s) => s.growth), centre.growth),
  };

  const record = usable.filter((s) => s.has_token === 1).length;
  const recordShare = usable.length > 0 ? record / usable.length : 0;

  const beta = fitLogistic(usable, centre, scale);
  const intercept = beta[0];
  const coef = { log_tvl: beta[1], log_age: beta[2], growth: beta[3] };

  // Ten-fold: each tenth is priced by a fit that never saw it.
  const truth: number[] = [];
  const pred: number[] = [];
  const basePred: number[] = [];
  for (let fold = 0; fold < 10; fold++) {
    const train = usable.filter((_, i) => i % 10 !== fold);
    const test = usable.filter((_, i) => i % 10 === fold);
    if (train.length < 8 || test.length === 0) continue;
    const b = fitLogistic(train, centre, scale);
    const trainShare = train.filter((s) => s.has_token === 1).length / train.length;
    for (const s of test) {
      truth.push(s.has_token);
      pred.push(predictWith(b, s, centre, scale));
      basePred.push(trainShare);
    }
  }

  // Walk-forward: order by age, train on the earlier two thirds, test on the later third.
  const ordered = [...usable].sort((a, b) => a.log_age - b.log_age || a.log_tvl - b.log_tvl);
  const cut = Math.floor(ordered.length * (2 / 3));
  const train = ordered.slice(0, cut);
  const test = ordered.slice(cut);
  let brierWalk = 0;
  let calledWalk = 0;
  if (train.length >= 8 && test.length > 0) {
    const b = fitLogistic(train, centre, scale);
    const trainShare = train.filter((s) => s.has_token === 1).length / train.length;
    const wt = test.map((s) => s.has_token);
    const wp = test.map((s) => predictWith(b, s, centre, scale));
    brierWalk = brierOf(wt, wp);
    calledWalk = shareCalledRight(wt, wp);
    if (brierWalk === 0) brierWalk = brierOf(wt, test.map(() => trainShare));
  }

  return {
    intercept,
    coef,
    centre,
    scale,
    rows: usable.length,
    record_share: recordShare,
    brier: brierOf(truth, pred),
    brier_base: brierOf(truth, basePred),
    called_right: shareCalledRight(truth, pred),
    called_right_base: shareCalledRight(truth, basePred),
    brier_walk: brierWalk,
    called_right_walk: calledWalk,
    floor,
    ceiling,
  };
}

/** The odds one row carries, clamped so a thin corner of the fit cannot claim certainty. */
export function oddsFor(model: OddsModel, s: Omit<OddsSample, 'has_token'>): number {
  if (!(model.rows > 0)) return model.record_share;
  const x = design({ ...s, has_token: 0 }, model.centre, model.scale);
  const p = sigmoid(
    model.intercept + model.coef.log_tvl * x[1] + model.coef.log_age * x[2] + model.coef.growth * x[3],
  );
  if (!Number.isFinite(p)) return model.record_share;
  return Math.min(model.ceiling, Math.max(model.floor, p));
}
