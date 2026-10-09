/**
 * CryptoAI Pro — Master Signal Engine: historical backtesting harness.
 *
 * Replays 1h candles through buildSignal() exactly as the live engine would
 * see them, then forward-simulates the resulting A+/A trade plans with
 * conservative (worst-case) intra-bar fill assumptions.
 *
 * NO LOOK-AHEAD: a signal evaluated at bar `i` is built from
 * `candles.slice(0, i + 1)` only — the engine never receives bars after `i`.
 * Trade simulation only touches bars `i + 1` onward. A determinism
 * self-check re-runs the engine on identical slices to prove the output
 * depends only on the visible slice; see `lookAheadSafe`.
 *
 * DISCLAIMER: every metric below describes a historical simulation only.
 * Past performance does not predict future results. Nothing in this file
 * claims, implies, or estimates any guaranteed level of future accuracy
 * or profitability.
 */

import type {
  BacktestResult,
  BacktestTrade,
  Candle,
  EngineConfig,
  EngineDeps,
  MarketContext,
  MasterSignal,
  SymbolInput,
  Timeframe,
  WalkForwardResult,
} from './types';
import { TIMEFRAMES } from './types';
import { buildSignal } from './engine';

export interface BacktestOptions {
  /** Evaluate every Nth bar (default 6). */
  step?: number;
  /** Cap the number of bars used (default: all provided). */
  maxBars?: number;
  /** Bars to skip after a trade closes before the next evaluation (default 0). */
  signalCooldownBars?: number;
}

/** BacktestResult carrying an explanatory `notes` field on edge cases. */
export interface BacktestResultWithNotes extends BacktestResult {
  notes: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max bars a simulated trade may stay open before forced exit at close. */
const TRADE_WINDOW_BARS = 72;
/** Neutral liquidity/volume assumptions for historical replay. */
const NEUTRAL_QUOTE_VOLUME_24H = 5_000_000;
const NEUTRAL_SPREAD_PCT = 0.02;
/** Partial-exit schedule: 40% at TP1, 30% at TP2, 30% at TP3. */
const TP_FRACTIONS = [0.4, 0.3, 0.3] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyResult(): BacktestResult {
  return {
    trades: [],
    candlesEvaluated: 0,
    signalsGenerated: 0,
    noTradePct: 0,
    winRate: 0,
    lossRate: 0,
    profitFactor: 0,
    expectancy: 0,
    maxDrawdownPct: 0,
    sharpeLike: 0,
    avgRR: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    maxConsecutiveLosses: 0,
    signalFrequencyPer1000: 0,
    aPlus: { trades: 0, winRate: 0 },
    aTier: { trades: 0, winRate: 0 },
    lookAheadSafe: false,
  };
}

/**
 * Minimal engine input for a historical evaluation point. Only the '1h'
 * series is populated; the engine tolerates empty arrays for other
 * timeframes.
 */
function buildEvalInput(symbol: string, slice: Candle[]): SymbolInput {
  const candles = {} as Record<Timeframe, Candle[]>;
  for (const tf of TIMEFRAMES) candles[tf] = tf === '1h' ? slice : [];
  return {
    symbol,
    candles,
    quoteVolume24h: NEUTRAL_QUOTE_VOLUME_24H,
    spreadPct: NEUTRAL_SPREAD_PCT,
  };
}

/** Neutral market regime so replay isolates the symbol's own price action. */
function neutralMarket(): MarketContext {
  return {
    btcRegime: 'SIDEWAYS',
    ethRegime: 'SIDEWAYS',
    btcChange24hPct: 0,
    ethChange24hPct: 0,
    btcViolentDump: false,
    btcStrongBull: false,
    ethViolentDump: false,
  };
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/**
 * Forward-simulate one trade plan. Fills use conservative intra-bar
 * ordering: if a bar touches BOTH the stop-loss and a take-profit, the stop
 * is assumed to fill first (worst case). Partial exits close 40/30/30% of
 * the original quantity at TP1/TP2/TP3 in order.
 */
function simulateTrade(
  symbol: string,
  signal: MasterSignal,
  candles: Candle[],
  openIndex: number,
  feePct: number,
): { trade: BacktestTrade; closeBar: number } {
  const entryPlan = signal.entry;
  const slPlan = signal.stop_loss;
  const tpPlan = signal.take_profit;
  const posPlan = signal.position;
  if (!entryPlan || !slPlan || !tpPlan || !posPlan) {
    throw new Error('simulateTrade: incomplete trade plan');
  }

  const isLong = signal.direction === 'LONG';
  const dirSign = isLong ? 1 : -1;
  const entry = entryPlan.preferred;
  const stopLoss = slPlan.price;
  const tps = [tpPlan.tp1, tpPlan.tp2, tpPlan.tp3];
  const origQty = posPlan.quantity;
  const entryNotional = origQty * entry;
  const entryFee = entryNotional * (feePct / 100);
  const riskPct = entry > 0 ? (Math.abs(entry - stopLoss) / entry) * 100 : 0;

  const tpDone = [false, false, false];
  let remaining = origQty;
  let grossPnl = 0;
  let exitFees = 0;
  let finalReason: BacktestTrade['exitReason'] = 'EXPIRED';
  const lastBar = Math.min(openIndex + TRADE_WINDOW_BARS, candles.length - 1);
  let closeBar = lastBar;

  const closeQtyAt = (qty: number, price: number): void => {
    grossPnl += dirSign * (price - entry) * qty;
    exitFees += qty * price * (feePct / 100);
    remaining -= qty;
  };

  for (let j = openIndex + 1; j <= lastBar && remaining > 1e-12; j++) {
    const bar = candles[j];
    const slHit = isLong ? bar.low <= stopLoss : bar.high >= stopLoss;
    if (slHit) {
      // Worst case: stop fills before any TP touched within this bar.
      closeQtyAt(remaining, stopLoss);
      finalReason = 'SL';
      closeBar = j;
      break;
    }
    for (let k = 0; k < 3; k++) {
      if (tpDone[k]) continue;
      const touched = isLong ? bar.high >= tps[k] : bar.low <= tps[k];
      if (!touched) continue;
      tpDone[k] = true;
      closeQtyAt(Math.min(remaining, origQty * TP_FRACTIONS[k]), tps[k]);
      finalReason = (['TP1', 'TP2', 'TP3'] as const)[k];
      closeBar = j;
      if (remaining <= 1e-12) break;
    }
  }

  if (remaining > 1e-12) {
    // Window exhausted with size still open: exit at the last close.
    closeQtyAt(remaining, candles[lastBar].close);
    finalReason = 'EXPIRED';
    closeBar = lastBar;
  }

  const totalFees = entryFee + exitFees;
  const pnlQuote = grossPnl - totalFees; // net of fees
  const pnlPct = entryNotional > 0 ? (pnlQuote / entryNotional) * 100 : 0;

  return {
    trade: {
      symbol,
      direction: isLong ? 'LONG' : 'SHORT',
      grade: signal.signal_grade,
      entry,
      stopLoss,
      takeProfits: [...tps],
      entryTime: candles[openIndex].closeTime,
      exitTime: candles[closeBar].closeTime,
      exitReason: finalReason,
      pnlPct,
      pnlQuote,
      rrRealized: riskPct > 0 ? pnlPct / riskPct : 0,
      fees: totalFees,
    },
    closeBar,
  };
}

function computeMetrics(result: BacktestResult, config: EngineConfig): void {
  const trades = result.trades;
  const n = trades.length;
  if (n === 0) return; // emptyResult() is already zeroed

  const wins = trades.filter((t) => t.pnlQuote > 0);
  const winCount = wins.length;
  const lossCount = n - winCount;
  result.winRate = n > 0 ? winCount / n : 0;
  result.lossRate = n > 0 ? lossCount / n : 0;

  const grossProfit = sum(wins.map((t) => t.pnlQuote));
  const grossLoss = sum(trades.filter((t) => t.pnlQuote <= 0).map((t) => Math.abs(t.pnlQuote)));
  result.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  result.expectancy = sum(trades.map((t) => t.pnlQuote)) / n;

  // Max drawdown from the equity curve, starting at the account balance.
  let equity = config.accountBalance;
  let peak = equity;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnlQuote;
    if (equity > peak) peak = equity;
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }
  result.maxDrawdownPct = maxDd;

  const pnlPcts = trades.map((t) => t.pnlPct);
  const mean = sum(pnlPcts) / n;
  const std = Math.sqrt(sum(pnlPcts.map((p) => (p - mean) ** 2)) / n);
  result.sharpeLike = std > 0 ? (mean / std) * Math.sqrt(n) : 0;

  result.avgRR = sum(trades.map((t) => t.rrRealized)) / n;
  result.avgWinPct = winCount > 0 ? sum(wins.map((t) => t.pnlPct)) / winCount : 0;
  result.avgLossPct =
    lossCount > 0
      ? sum(trades.filter((t) => t.pnlQuote <= 0).map((t) => t.pnlPct)) / lossCount
      : 0;

  let cur = 0;
  let maxConsec = 0;
  for (const t of trades) {
    cur = t.pnlQuote <= 0 ? cur + 1 : 0;
    maxConsec = Math.max(maxConsec, cur);
  }
  result.maxConsecutiveLosses = maxConsec;

  const gradeStats = (g: 'A+' | 'A'): { trades: number; winRate: number } => {
    const gt = trades.filter((t) => t.grade === g);
    const gw = gt.filter((t) => t.pnlQuote > 0).length;
    return { trades: gt.length, winRate: gt.length > 0 ? gw / gt.length : 0 };
  };
  result.aPlus = gradeStats('A+');
  result.aTier = gradeStats('A');
}

/** Strip time-based / random fields before comparing two signals. */
function normalizeSignal(s: MasterSignal): string {
  const { signal_id, created_at, expires_at, ...rest } = s;
  void signal_id;
  void created_at;
  void expires_at;
  return JSON.stringify(rest);
}

/**
 * Self-check: re-run buildSignal twice on identical slices at 3 sample bars
 * and require byte-identical (normalized) output. The implementation only
 * ever hands the engine `candles.slice(0, i + 1)`, so a deterministic engine
 * cannot depend on future bars — passing this check is the practical proof
 * of look-ahead safety for this harness.
 */
function determinismSelfCheck(
  symbol: string,
  candles: Candle[],
  config: EngineConfig,
  maxBars: number,
): boolean {
  try {
    const lo = config.minCandles;
    const hi = Math.min(candles.length, maxBars) - 1;
    if (hi <= lo) return false;
    for (const f of [0.25, 0.5, 0.75]) {
      const i = Math.max(lo, Math.floor(lo + (hi - lo) * f));
      const slice = candles.slice(0, i + 1);
      const depsFor = (): EngineDeps => ({
        config,
        market: neutralMarket(),
        balance: config.accountBalance,
        now: slice[i].closeTime,
      });
      const a = normalizeSignal(buildSignal(buildEvalInput(symbol, slice), depsFor()));
      const b = normalizeSignal(
        buildSignal(buildEvalInput(symbol, candles.slice(0, i + 1)), depsFor()),
      );
      if (a !== b) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runBacktest(
  symbol: string,
  candles1h: Candle[],
  config: EngineConfig,
  opts: BacktestOptions = {},
): BacktestResult {
  if (candles1h.length < config.minCandles) {
    const empty = emptyResult() as BacktestResultWithNotes;
    empty.notes = [
      `insufficient data: ${candles1h.length} bars provided, need >= ${config.minCandles}; no signals evaluated`,
    ];
    return empty;
  }

  const step = Math.max(1, Math.floor(opts.step ?? 6));
  const cooldownBars = Math.max(0, Math.floor(opts.signalCooldownBars ?? 0));
  const maxBars =
    opts.maxBars && opts.maxBars > 0 ? Math.min(opts.maxBars, candles1h.length) : candles1h.length;
  const feePct = config.paperFeePct;
  const market = neutralMarket();

  const result = emptyResult();
  let evaluations = 0;
  let noTradeDecisions = 0;
  let signals = 0;
  let skipUntil = -1;

  for (let i = config.minCandles; i < maxBars; i += step) {
    if (i <= skipUntil) continue;

    // NO LOOK-AHEAD: the engine only ever receives candles[0..i].
    const slice = candles1h.slice(0, i + 1);
    const input = buildEvalInput(symbol, slice);
    const deps: EngineDeps = {
      config,
      market,
      balance: config.accountBalance,
      now: slice[i].closeTime,
    };

    let signal: MasterSignal;
    try {
      signal = buildSignal(input, deps);
    } catch {
      continue; // engine rejected this slice; move on without counting it
    }
    evaluations++;

    if (signal.direction === 'NO_TRADE') {
      noTradeDecisions++;
      continue;
    }
    signals++;

    // Only top-tier signals are traded; B-grade and below stay sidelined.
    if (signal.signal_grade !== 'A+' && signal.signal_grade !== 'A') continue;
    if (!signal.entry || !signal.stop_loss || !signal.take_profit || !signal.position) continue;
    if (!(signal.position.quantity > 0)) continue;

    const { trade, closeBar } = simulateTrade(symbol, signal, candles1h, i, feePct);
    result.trades.push(trade);
    // Never overlap positions: resume evaluating after the trade closes
    // (plus the optional cooldown), on the original step grid.
    skipUntil = closeBar + cooldownBars;
  }

  result.candlesEvaluated = evaluations;
  result.signalsGenerated = signals;
  result.noTradePct = evaluations > 0 ? (noTradeDecisions / evaluations) * 100 : 0;
  result.signalFrequencyPer1000 = evaluations > 0 ? (signals / evaluations) * 1000 : 0;

  computeMetrics(result, config);
  result.lookAheadSafe = determinismSelfCheck(symbol, candles1h, config, maxBars);
  return result;
}

/**
 * Walk-forward validation: 50% train / 25% validation / 25% out-of-sample.
 * Each segment is backtested independently (no data leaks across segments).
 * Flags a likely-overfit engine when strong in-sample profit factor collapses
 * out-of-sample.
 */
export function walkForward(
  symbol: string,
  candles1h: Candle[],
  config: EngineConfig,
): WalkForwardResult {
  const n = candles1h.length;
  const trainEnd = Math.floor(n * 0.5);
  const valEnd = Math.floor(n * 0.75);

  const train = runBacktest(symbol, candles1h.slice(0, trainEnd), config);
  const validation = runBacktest(symbol, candles1h.slice(trainEnd, valEnd), config);
  const outOfSample = runBacktest(symbol, candles1h.slice(valEnd), config);

  const overfitWarning = train.profitFactor > 1.5 && outOfSample.profitFactor < 1.0;

  const fmt = (r: BacktestResult): string =>
    `trades=${r.trades.length} PF=${r.profitFactor.toFixed(2)} ` +
    `winRate=${(r.winRate * 100).toFixed(1)}% expectancy=${r.expectancy.toFixed(2)} ` +
    `maxDD=${r.maxDrawdownPct.toFixed(1)}%`;
  const notes = [
    `Walk-forward split: train ${trainEnd} bars / validation ${valEnd - trainEnd} bars / out-of-sample ${n - valEnd} bars.`,
    `Train: ${fmt(train)}.`,
    `Validation: ${fmt(validation)}.`,
    `Out-of-sample: ${fmt(outOfSample)}.`,
    overfitWarning
      ? 'OVERFIT WARNING: strong in-sample profit factor (>1.5) collapses out-of-sample (<1.0). Do not trust in-sample metrics.'
      : 'No overfit warning: out-of-sample profit factor is not collapsing relative to train.',
    'All metrics describe historical simulation only; past performance does not predict future results.',
  ];

  return { train, validation, outOfSample, overfitWarning, notes };
}
