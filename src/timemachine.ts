/**
 * CryptoAI Pro — Time Machine: simulate a trade setup before risking money.
 *
 * Takes one setup (symbol, direction, stop-loss distance and TP distances as
 * percentages from entry) and replays it across historical closed candles:
 * at every evaluated bar the setup is hypothetically entered at that bar's
 * close, then settled forward with the SAME PaperTrader execution model the
 * live paper runner uses — stop-before-TP intra-bar ordering, 40/30/30
 * partial take-profits, per-leg fees, adverse entry/exit slippage, and 8h
 * funding. Results are aggregated into full stats (n, win rate, profit
 * factor, fee-inclusive expectancy, max drawdown).
 *
 * HONESTY: every metric describes a historical simulation only. Past
 * performance does not predict future results. A setup that "passes" the
 * historical gate below has still proven nothing about future trades — it
 * has only survived this history. Nothing here is a win probability, and
 * nothing here places a real order: this module never touches the live
 * paper ledger, open positions, or any exchange.
 *
 * NO LOOK-AHEAD: a simulated entry at bar `i` only ever sees bars `i+1`
 * onward for settlement. The caller must pass closed candles in ascending
 * time order; the API route drops the newest (possibly incomplete) candle.
 */

import { PaperTrader } from './paper';
import type { PaperCandle } from './paper';
import type {
  BacktestTrade,
  EngineConfig,
  MasterSignal,
} from './types';

/** A trade setup expressed as distances from entry, in percent. */
export interface TimeMachineSetup {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  /** Stop-loss distance from entry, percent (must be > 0). */
  slPct: number;
  /** Take-profit distances from entry, percent (must be > 0, ascending). */
  tp1Pct: number;
  tp2Pct: number;
  tp3Pct: number;
}

export interface TimeMachineOptions {
  /** Fixed USD risk per simulated trade (default 100). Quantity is sized so
   *  each trade risks exactly this amount at the stop, mirroring the engine's
   *  risk-capped sizing — so expectancy in USD is comparable across setups. */
  riskPerTradeUsd?: number;
  /** Max bars a simulated trade may stay open before forced exit at close
   *  with reason EXPIRED (default 72, matching the backtest window). */
  maxHoldBars?: number;
  /** Evaluate every Nth bar as a hypothetical entry (default 1 = every bar). */
  stepBars?: number;
}

export interface TimeMachineResult {
  setup: TimeMachineSetup;
  /** Number of closed candles the simulation ran over. */
  candlesUsed: number;
  /** Number of hypothetical entries evaluated (bars with a forward window). */
  entriesEvaluated: number;
  trades: BacktestTrade[];
  /** Closed-trade count (equals trades.length; kept explicit for readers). */
  n: number;
  /** Fractions 0..1. */
  winRate: number;
  lossRate: number;
  profitFactor: number;
  /** Net USD per trade, fees + funding + slippage included. */
  expectancy: number;
  netPnl: number;
  totalFees: number;
  avgWin: number;
  avgLoss: number;
  best: number;
  worst: number;
  maxDrawdownPct: number;
  maxConsecutiveLosses: number;
  /** Historical-gate verdict (subset of the paper-validation gate; the
   *  no-trade-rate condition does not apply to a setup simulation). */
  verdict: 'PASSES_HISTORICAL_GATE' | 'DOES_NOT_PASS';
  verdictReasons: string[];
  notes: string[];
}

/** Historical gate thresholds, shared with the paper-validation doctrine. */
export const TIME_MACHINE_GATE = {
  minTrades: 30,
  minProfitFactor: 1.2,
  maxDrawdownPct: 25,
} as const;

function isFinitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

export function validateSetup(setup: TimeMachineSetup): void {
  if (!setup || typeof setup.symbol !== 'string' || setup.symbol.length === 0) {
    throw new Error('Time Machine: setup.symbol is required');
  }
  if (setup.direction !== 'LONG' && setup.direction !== 'SHORT') {
    throw new Error('Time Machine: direction must be LONG or SHORT');
  }
  if (!isFinitePositive(setup.slPct)) {
    throw new Error('Time Machine: slPct must be > 0');
  }
  for (const [name, v] of [
    ['tp1Pct', setup.tp1Pct],
    ['tp2Pct', setup.tp2Pct],
    ['tp3Pct', setup.tp3Pct],
  ] as const) {
    if (!isFinitePositive(v)) {
      throw new Error(`Time Machine: ${name} must be > 0`);
    }
  }
  if (!(setup.tp1Pct <= setup.tp2Pct && setup.tp2Pct <= setup.tp3Pct)) {
    throw new Error('Time Machine: TP distances must be ascending (tp1 <= tp2 <= tp3)');
  }
}

function levelsFor(entry: number, setup: TimeMachineSetup): {
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
} {
  const sign = setup.direction === 'LONG' ? 1 : -1;
  return {
    stopLoss: entry * (1 - sign * (setup.slPct / 100)),
    tp1: entry * (1 + sign * (setup.tp1Pct / 100)),
    tp2: entry * (1 + sign * (setup.tp2Pct / 100)),
    tp3: entry * (1 + sign * (setup.tp3Pct / 100)),
  };
}

/**
 * Build the synthetic ACTIVE signal PaperTrader needs. MARKET entry at the
 * entry bar's close; created_at is the entry bar's close time so the R1
 * stale-candle guard settles only strictly-later bars. Grade 'A' is a
 * simulation marker, not an engine grade — the signal never reaches the
 * runner, the ledger, or any display of live signals.
 */
function syntheticSignal(
  entryBar: PaperCandle,
  setup: TimeMachineSetup,
  riskPerTradeUsd: number,
): MasterSignal {
  const entry = entryBar.close;
  const lv = levelsFor(entry, setup);
  const slDistance = Math.abs(entry - lv.stopLoss);
  const closeTime =
    typeof entryBar.closeTime === 'number' && Number.isFinite(entryBar.closeTime)
      ? entryBar.closeTime
      : entryBar.openTime;
  return {
    signal_id: `timemachine-${setup.symbol}-${closeTime}`,
    symbol: setup.symbol,
    direction: setup.direction,
    status: 'ACTIVE',
    signal_grade: 'A',
    long_score: 0,
    short_score: 0,
    confidence: 0,
    probability_estimate: 0,
    probability_note:
      'Time Machine simulation — not a probability, not a prediction.',
    market_regime: 'SIDEWAYS',
    entry: {
      low: entry,
      high: entry,
      preferred: entry,
      type: 'MARKET',
      reason: 'timemachine: hypothetical entry at bar close',
    },
    stop_loss: {
      price: lv.stopLoss,
      distance_percent: setup.slPct,
      reason: 'timemachine setup',
    },
    take_profit: {
      tp1: lv.tp1,
      tp2: lv.tp2,
      tp3: lv.tp3,
      reasons: ['timemachine setup'],
    },
    risk_reward: null,
    position: {
      risk_percent: 0,
      risk_amount: riskPerTradeUsd,
      quantity: slDistance > 0 ? riskPerTradeUsd / slDistance : 0,
      notional: 0,
      leverage: 1,
    },
    market_price: entry,
    mtf: {
      '1m': 'NEUTRAL',
      '5m': 'NEUTRAL',
      '15m': 'NEUTRAL',
      '1h': 'NEUTRAL',
      '4h': 'NEUTRAL',
      '1d': 'NEUTRAL',
    },
    confirmation: {
      trend: false,
      structure: false,
      momentum: false,
      volume: false,
      vwap: false,
      breakout: false,
      liquidity: false,
    },
    reasons: ['timemachine: hypothetical setup replay'],
    warnings: [],
    invalidation: [],
    correlation_score: 0,
    ai_rating: 'AI_NEUTRAL',
    watch: null,
    created_at: new Date(closeTime).toISOString(),
    expires_at: new Date(closeTime).toISOString(),
  };
}

/**
 * Replay `setup` over `candles` (ascending closed candles) and return full
 * stats. Pure: creates its own PaperTrader, never touches live state.
 */
export function simulateSetupHistory(
  candles: PaperCandle[],
  setup: TimeMachineSetup,
  config: EngineConfig,
  opts: TimeMachineOptions = {},
): TimeMachineResult {
  validateSetup(setup);
  const riskPerTradeUsd = opts.riskPerTradeUsd ?? 100;
  if (!isFinitePositive(riskPerTradeUsd)) {
    throw new Error('Time Machine: riskPerTradeUsd must be > 0');
  }
  const maxHoldBars = opts.maxHoldBars ?? 72;
  if (!Number.isInteger(maxHoldBars) || maxHoldBars < 1) {
    throw new Error('Time Machine: maxHoldBars must be a positive integer');
  }
  const stepBars = opts.stepBars ?? 1;
  if (!Number.isInteger(stepBars) || stepBars < 1) {
    throw new Error('Time Machine: stepBars must be a positive integer');
  }

  const trader = new PaperTrader(config);
  const trades: BacktestTrade[] = [];
  let entriesEvaluated = 0;

  // Last bar has no forward window, so it can never be an entry.
  for (let i = 0; i + 1 < candles.length; i += stepBars) {
    const entryBar = candles[i];
    if (!(entryBar.close > 0)) continue;
    const signal = syntheticSignal(entryBar, setup, riskPerTradeUsd);
    const opened = trader.openFromSignal(signal);
    if (!opened.id) continue; // defensive: should not happen for valid setups
    entriesEvaluated++;
    const before = trader.account.tradeHistory.length;

    let closed = false;
    const lastJ = Math.min(candles.length - 1, i + maxHoldBars);
    for (let j = i + 1; j <= lastJ; j++) {
      const bar = candles[j];
      const barEnd =
        typeof bar.closeTime === 'number' && Number.isFinite(bar.closeTime)
          ? bar.closeTime
          : bar.openTime;
      trader.accrueFunding(barEnd);
      trader.onCandle(setup.symbol, bar);
      if (trader.account.tradeHistory.length > before) {
        closed = true;
        break;
      }
    }
    if (!closed) {
      // Still open at the end of the hold window: force exit at last close.
      trader.closePosition(opened.id, candles[lastJ].close, 'EXPIRED');
    }
    const fresh = trader.account.tradeHistory.slice(before);
    trades.push(...fresh);
  }

  return buildResult(candles, setup, entriesEvaluated, trades, config);
}

function buildResult(
  candles: PaperCandle[],
  setup: TimeMachineSetup,
  entriesEvaluated: number,
  trades: BacktestTrade[],
  config: EngineConfig,
): TimeMachineResult {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlQuote > 0);
  const losses = trades.filter((t) => t.pnlQuote <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlQuote, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnlQuote), 0);
  const netPnl = trades.reduce((s, t) => s + t.pnlQuote, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);

  // Max drawdown from the equity curve, starting at the account balance —
  // same convention as the backtest harness.
  let equity = config.accountBalance;
  let peak = equity;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnlQuote;
    if (equity > peak) peak = equity;
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }

  let cur = 0;
  let maxConsec = 0;
  for (const t of trades) {
    cur = t.pnlQuote <= 0 ? cur + 1 : 0;
    maxConsec = Math.max(maxConsec, cur);
  }

  const verdictReasons: string[] = [];
  if (n < TIME_MACHINE_GATE.minTrades) {
    verdictReasons.push(
      `insufficient sample: ${n} trades (need >= ${TIME_MACHINE_GATE.minTrades})`,
    );
  }
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  if (profitFactor < TIME_MACHINE_GATE.minProfitFactor) {
    verdictReasons.push(
      `profit factor ${profitFactor.toFixed(2)} < ${TIME_MACHINE_GATE.minProfitFactor}`,
    );
  }
  if (maxDd > TIME_MACHINE_GATE.maxDrawdownPct) {
    verdictReasons.push(
      `max drawdown ${maxDd.toFixed(1)}% exceeds ${TIME_MACHINE_GATE.maxDrawdownPct}%`,
    );
  }
  const expectancy = n > 0 ? netPnl / n : 0;
  if (!(expectancy > 0)) {
    verdictReasons.push(`expectancy ${expectancy.toFixed(2)} is not positive`);
  }

  return {
    setup,
    candlesUsed: candles.length,
    entriesEvaluated,
    trades,
    n,
    winRate: n > 0 ? wins.length / n : 0,
    lossRate: n > 0 ? losses.length / n : 0,
    profitFactor,
    expectancy,
    netPnl,
    totalFees,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    best: n > 0 ? Math.max(...trades.map((t) => t.pnlQuote)) : 0,
    worst: n > 0 ? Math.min(...trades.map((t) => t.pnlQuote)) : 0,
    maxDrawdownPct: maxDd,
    maxConsecutiveLosses: maxConsec,
    verdict: verdictReasons.length === 0 ? 'PASSES_HISTORICAL_GATE' : 'DOES_NOT_PASS',
    verdictReasons,
    notes: [
      'Historical simulation only — past performance does not predict future results.',
      'Execution matches live paper trading: stop-before-TP ordering, 40/30/30 partial TPs, per-leg fees, adverse slippage, 8h funding.',
      'Each hypothetical trade risks a fixed USD amount at the stop; expectancy is net USD per trade after fees, funding and slippage.',
      'This simulation never touches the live paper ledger or open positions.',
    ],
  };
}
