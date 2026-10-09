/**
 * CryptoAI Pro — Master Signal Engine: paper-trading simulator.
 *
 * Virtual positions opened from ACTIVE A+/A signals, settled bar-by-bar
 * against closed candles with conservative (stop-before-TP) intra-bar
 * ordering, per-leg fees, adverse entry slippage, and 8-hourly funding.
 *
 * IMPORTANT: paper validation is required before ANY live trading, and this
 * codebase performs NO live order placement at all — there is no order
 * execution path here, only accounting.
 *
 * Accounting conventions:
 * - BacktestTrade.pnlQuote is NET of trading fees and funding; the `fees`
 *   field itemizes the total cost (trading fees + funding payments).
 * - A position is recorded in tradeHistory once, when fully closed, with
 *   pnl aggregated across its partial-exit legs and exitReason set to the
 *   final exit event.
 */

import type {
  BacktestResult,
  BacktestTrade,
  EngineConfig,
  MasterSignal,
  PaperAccount,
  PaperPosition,
  SignalGrade,
} from './types';

/** Partial-exit schedule: 40% at TP1, 30% at TP2, 30% at TP3 (of original qty). */
const TP_FRACTIONS = [0.4, 0.3, 0.3] as const;
const TP_REASONS = ['TP1', 'TP2', 'TP3'] as const;
const FUNDING_INTERVAL_MS = 8 * 3_600_000;

/** Candle shape accepted by onCandle; closeTime is optional (falls back to openTime). */
export interface PaperCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime?: number;
}

/** Internal bookkeeping per open position (partial-close state). */
interface PositionState {
  grade: SignalGrade;
  origQty: number;
  remainingQty: number;
  tpHit: boolean[];
  /** Net P&L so far, including entry fee, exit fees and funding. */
  realizedNet: number;
  /** Total trading fees + funding paid so far. */
  feesPaid: number;
  lastPrice: number;
  nextFundingMs: number;
}

export class PaperTrader {
  private readonly config: EngineConfig;
  private balance: number;
  private realizedPnl = 0;
  private totalFees = 0;
  private totalFunding = 0;
  private readonly positions = new Map<string, PaperPosition>();
  private readonly states = new Map<string, PositionState>();
  private readonly tradeHistory: BacktestTrade[] = [];
  private idSeq = 0;

  constructor(config: EngineConfig) {
    this.config = config;
    this.balance = config.paperStartBalance;
  }

  /** Current account snapshot. Equity includes unrealized P&L at last seen prices. */
  get account(): PaperAccount {
    let unrealized = 0;
    for (const [id, pos] of this.positions) {
      const st = this.states.get(id);
      if (!st) continue;
      const sign = pos.direction === 'LONG' ? 1 : -1;
      unrealized += sign * (st.lastPrice - pos.entry) * st.remainingQty;
    }
    return {
      balance: this.balance,
      equity: this.balance + unrealized,
      positions: [...this.positions.values()],
      realizedPnl: this.realizedPnl,
      totalFees: this.totalFees,
      totalFunding: this.totalFunding,
      tradeHistory: [...this.tradeHistory],
    };
  }

  /**
   * Open a virtual position from an ACTIVE A+/A signal.
   * Applies adverse entry slippage and the entry fee, and caps the quantity
   * so the position's risk cannot exceed the signal's planned risk_amount.
   */
  openFromSignal(signal: MasterSignal): { id: string | null; reason?: string } {
    if (signal.direction !== 'LONG' && signal.direction !== 'SHORT') {
      return { id: null, reason: 'rejected: signal direction is NO_TRADE' };
    }
    if (signal.status !== 'ACTIVE') {
      return { id: null, reason: `rejected: signal status is ${signal.status}, expected ACTIVE` };
    }
    if (signal.signal_grade !== 'A+' && signal.signal_grade !== 'A') {
      return { id: null, reason: `rejected: grade ${signal.signal_grade} is below A tier` };
    }
    if (!signal.entry || !signal.stop_loss || !signal.take_profit || !signal.position) {
      return { id: null, reason: 'rejected: incomplete trade plan (entry/SL/TP/position)' };
    }
    for (const p of this.positions.values()) {
      if (p.symbol === signal.symbol) {
        return { id: null, reason: `rejected: a position is already open for ${signal.symbol}` };
      }
    }

    // Adverse slippage: LONG pays up, SHORT gives up.
    const slip = this.config.paperSlippagePct / 100;
    const rawEntry = signal.entry.preferred;
    const fill =
      signal.direction === 'LONG' ? rawEntry * (1 + slip) : rawEntry * (1 - slip);

    // Cap quantity so risk stays as planned (risk = qty * |fill - SL|).
    let qty = signal.position.quantity;
    const plannedRisk = signal.position.risk_amount;
    const slDistance = Math.abs(fill - signal.stop_loss.price);
    if (plannedRisk > 0 && slDistance > 0) {
      const actualRisk = qty * slDistance;
      if (actualRisk > plannedRisk) qty = plannedRisk / slDistance;
    }
    if (!(qty > 0) || !Number.isFinite(qty)) {
      return { id: null, reason: 'rejected: non-positive quantity after risk cap' };
    }

    const entryFee = qty * fill * (this.config.paperFeePct / 100);
    const parsed = Date.parse(signal.created_at);
    const openedAt = Number.isFinite(parsed) ? parsed : Date.now();
    const id = `${signal.symbol}-${openedAt}-${++this.idSeq}`;

    const position: PaperPosition = {
      id,
      symbol: signal.symbol,
      direction: signal.direction,
      entry: fill,
      quantity: qty,
      leverage: signal.position.leverage,
      stopLoss: signal.stop_loss.price,
      takeProfits: [signal.take_profit.tp1, signal.take_profit.tp2, signal.take_profit.tp3],
      openedAt,
      fees: entryFee,
    };
    this.positions.set(id, position);
    this.states.set(id, {
      grade: signal.signal_grade,
      origQty: qty,
      remainingQty: qty,
      tpHit: [false, false, false],
      realizedNet: -entryFee,
      feesPaid: entryFee,
      lastPrice: fill,
      nextFundingMs: openedAt + FUNDING_INTERVAL_MS,
    });
    this.balance -= entryFee;
    this.totalFees += entryFee;
    return { id };
  }

  /**
   * Feed the latest closed candle for a symbol; settles SL/TP hits.
   * Conservative intra-bar ordering: the stop is checked before take-profits
   * within the same bar (worst case). TPs settle in order with 40/30/30%
   * partial closes.
   */
  onCandle(symbol: string, candle: PaperCandle): void {
    for (const [id, pos] of [...this.positions]) {
      if (pos.symbol !== symbol) continue;
      const st = this.states.get(id);
      if (!st) continue;
      st.lastPrice = candle.close;

      const isLong = pos.direction === 'LONG';
      const slHit = isLong ? candle.low <= pos.stopLoss : candle.high >= pos.stopLoss;
      if (slHit) {
        this.closeLeg(id, pos.stopLoss, st.remainingQty, 'SL', this.exitTimeOf(candle));
        continue;
      }

      const n = Math.min(pos.takeProfits.length, TP_FRACTIONS.length);
      for (let k = 0; k < n; k++) {
        if (st.tpHit[k]) continue;
        const touched = isLong
          ? candle.high >= pos.takeProfits[k]
          : candle.low <= pos.takeProfits[k];
        if (!touched) continue;
        st.tpHit[k] = true;
        const qtyToClose = Math.min(st.remainingQty, st.origQty * TP_FRACTIONS[k]);
        this.closeLeg(id, pos.takeProfits[k], qtyToClose, TP_REASONS[k], this.exitTimeOf(candle));
        if (!this.positions.has(id)) break; // fully closed by this leg
      }
    }
  }

  /** Accrue funding on every open position for each 8h period elapsed. */
  accrueFunding(nowMs: number): void {
    const rate = this.config.paperFundingPct8h / 100;
    if (!(rate > 0)) return;
    for (const [id, pos] of this.positions) {
      const st = this.states.get(id);
      if (!st) continue;
      while (st.nextFundingMs <= nowMs) {
        const funding = st.remainingQty * pos.entry * rate;
        st.realizedNet -= funding;
        st.feesPaid += funding;
        this.balance -= funding;
        this.realizedPnl -= funding;
        this.totalFunding += funding;
        st.nextFundingMs += FUNDING_INTERVAL_MS;
      }
    }
  }

  /** Manually close the remaining size of a position at a given price. */
  closePosition(id: string, price: number, reason: BacktestTrade['exitReason']): void {
    const st = this.states.get(id);
    if (!st) return;
    this.closeLeg(id, price, st.remainingQty, reason, Date.now());
  }

  /** Reset the account to its starting balance and clear all state. */
  reset(): void {
    this.balance = this.config.paperStartBalance;
    this.realizedPnl = 0;
    this.totalFees = 0;
    this.totalFunding = 0;
    this.positions.clear();
    this.states.clear();
    this.tradeHistory.length = 0;
    this.idSeq = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private exitTimeOf(candle: PaperCandle): number {
    return typeof candle.closeTime === 'number' && Number.isFinite(candle.closeTime)
      ? candle.closeTime
      : candle.openTime;
  }

  /**
   * Close `qty` of a position at `price`, applying the exit fee. When the
   * position is fully closed, emits one aggregated BacktestTrade into the
   * trade history with the final leg's exit reason.
   */
  private closeLeg(
    id: string,
    price: number,
    qty: number,
    reason: BacktestTrade['exitReason'],
    exitTime: number,
  ): void {
    const pos = this.positions.get(id);
    const st = this.states.get(id);
    if (!pos || !st || !(qty > 0)) return;
    const closeQty = Math.min(qty, st.remainingQty);
    if (!(closeQty > 0)) return;

    const sign = pos.direction === 'LONG' ? 1 : -1;
    const gross = sign * (price - pos.entry) * closeQty;
    const fee = closeQty * price * (this.config.paperFeePct / 100);
    const net = gross - fee;

    st.remainingQty -= closeQty;
    st.realizedNet += net;
    st.feesPaid += fee;
    this.balance += net;
    this.realizedPnl += net;
    this.totalFees += fee;
    pos.fees += fee;
    pos.quantity = Math.max(0, st.remainingQty);

    if (st.remainingQty <= 1e-12) {
      const entryNotional = st.origQty * pos.entry;
      const riskPct =
        pos.entry > 0 ? (Math.abs(pos.entry - pos.stopLoss) / pos.entry) * 100 : 0;
      const pnlPct = entryNotional > 0 ? (st.realizedNet / entryNotional) * 100 : 0;
      this.tradeHistory.push({
        symbol: pos.symbol,
        direction: pos.direction,
        grade: st.grade,
        entry: pos.entry,
        stopLoss: pos.stopLoss,
        takeProfits: [...pos.takeProfits],
        entryTime: pos.openedAt,
        exitTime,
        exitReason: reason,
        pnlPct,
        pnlQuote: st.realizedNet,
        rrRealized: riskPct > 0 ? pnlPct / riskPct : 0,
        fees: st.feesPaid,
      });
      this.positions.delete(id);
      this.states.delete(id);
    }
  }
}

/**
 * Live-readiness gate for backtest results. Paper validation is required
 * before any live trading, and this codebase performs NO live order
 * placement at all.
 */
export function canGoLive(result: BacktestResult): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.trades.length < 30) {
    reasons.push(`insufficient sample: ${result.trades.length} trades (need >= 30)`);
  }
  if (result.profitFactor < 1.2) {
    reasons.push(`profit factor ${result.profitFactor.toFixed(2)} < 1.20`);
  }
  if (result.maxDrawdownPct > 25) {
    reasons.push(`max drawdown ${result.maxDrawdownPct.toFixed(1)}% exceeds 25%`);
  }
  if (!(result.expectancy > 0)) {
    reasons.push(`expectancy ${result.expectancy.toFixed(2)} is not positive`);
  }
  if (result.noTradePct < 20) {
    reasons.push(
      `no-trade rate ${result.noTradePct.toFixed(1)}% < 20% (insufficient selectivity)`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}
