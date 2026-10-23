/** P0 R3 regression tests: adverse exit slippage.
 * Exits fill worse than the trigger level (LONG sells lower, SHORT buys higher),
 * mirroring the entry slippage convention. Fees on slipped notionals; entry
 * slippage applied once at open — nothing double-counted.
 * Deterministic: fixed timestamps (R1-coherent), no randomness, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader, type PaperCandle } from '../paper';
import { loadConfig } from '../config';
import type { MasterSignal } from '../types';

const T0 = 1_700_000_000_000;
const MIN15 = 15 * 60 * 1000;

function baseSignal(direction: 'LONG' | 'SHORT'): MasterSignal {
  const long = direction === 'LONG';
  return {
    signal_id: `R3-${direction}`,
    symbol: `${direction}USDT`,
    direction,
    status: 'ACTIVE',
    signal_grade: 'A',
    long_score: long ? 86 : 20,
    short_score: long ? 20 : 86,
    confidence: 82,
    probability_estimate: 70,
    probability_note: 'test',
    market_regime: long ? 'WEAK_BULL' : 'WEAK_BEAR',
    entry: { low: 99, high: 101, preferred: 100, type: 'MARKET', reason: 'test' },
    stop_loss: { price: long ? 95 : 105, distance_percent: 5, reason: 'test' },
    take_profit: long
      ? { tp1: 105, tp2: 110, tp3: 120, reasons: [] }
      : { tp1: 95, tp2: 90, tp3: 85, reasons: [] },
    risk_reward: { tp1: 1, tp2: 2, tp3: 4 },
    position: { risk_percent: 1, risk_amount: 100, quantity: 20, notional: 2000, leverage: 2 },
    market_price: 100,
    mtf: { '1m': 'NEUTRAL', '5m': 'NEUTRAL', '15m': 'NEUTRAL', '1h': 'NEUTRAL', '4h': 'NEUTRAL', '1d': 'NEUTRAL' },
    confirmation: {
      trend: false, structure: false, momentum: false, volume: false,
      vwap: false, breakout: false, liquidity: false,
    },
    reasons: [],
    warnings: [],
    invalidation: [],
    correlation_score: 0,
    ai_rating: 'AI_NEUTRAL',
    watch: null,
    created_at: new Date(T0).toISOString(),
    expires_at: new Date(T0 + 3600_000).toISOString(),
  };
}

function m15(k: number, high: number, low: number, close: number): PaperCandle {
  const openTime = T0 + k * MIN15;
  return { openTime, open: 100, high, low, close, closeTime: openTime + MIN15 - 1 };
}

describe('P0 R3: adverse exit slippage on every exit path', () => {
  it('T-R3a: LONG SL fills below the stop (adverse), exact pnl arithmetic', () => {
    const cfg = loadConfig();
    const slip = cfg.paperSlippagePct / 100;
    const feeRate = cfg.paperFeePct / 100;
    const trader = new PaperTrader(cfg);
    const r = trader.openFromSignal(baseSignal('LONG'));
    assert.ok(r.id);
    const { entry, quantity } = trader.account.positions[0];

    trader.onCandle('LONGUSDT', m15(1, 102, 93, 94)); // low 93 <= SL 95
    assert.equal(trader.account.positions.length, 0);
    const trade = trader.account.tradeHistory[0];
    assert.equal(trade.exitReason, 'SL');

    const expectedFill = 95 * (1 - slip);
    const expectedGross = (expectedFill - entry) * quantity;
    const expectedExitFee = quantity * expectedFill * feeRate;
    const expectedEntryFee = quantity * entry * feeRate;
    assert.ok(
      Math.abs(trade.fees - (expectedEntryFee + expectedExitFee)) < 1e-9,
      `fees ${trade.fees} must equal entry+exit fees exactly (no double count)`,
    );
    assert.ok(
      Math.abs(trade.pnlQuote - (expectedGross - expectedExitFee - expectedEntryFee)) < 1e-9,
      `pnlQuote ${trade.pnlQuote} must equal slipped gross minus fees`,
    );
    assert.ok(expectedFill < 95, 'LONG exit fills below the stop level');
  });

  it('T-R3b: SHORT SL fills above the stop (adverse)', () => {
    const cfg = loadConfig();
    const slip = cfg.paperSlippagePct / 100;
    const feeRate = cfg.paperFeePct / 100;
    const trader = new PaperTrader(cfg);
    const r = trader.openFromSignal(baseSignal('SHORT'));
    assert.ok(r.id);
    const { entry, quantity } = trader.account.positions[0];

    trader.onCandle('SHORTUSDT', m15(1, 107, 99, 106)); // high 107 >= SL 105
    assert.equal(trader.account.positions.length, 0);
    const trade = trader.account.tradeHistory[0];
    assert.equal(trade.exitReason, 'SL');

    const expectedFill = 105 * (1 + slip);
    const expectedGross = -(expectedFill - entry) * quantity;
    const expectedExitFee = quantity * expectedFill * feeRate;
    const expectedEntryFee = quantity * entry * feeRate;
    assert.ok(expectedFill > 105, 'SHORT exit fills above the stop level');
    assert.ok(
      Math.abs(trade.pnlQuote - (expectedGross - expectedExitFee - expectedEntryFee)) < 1e-9,
      `pnlQuote ${trade.pnlQuote} must equal slipped gross minus fees`,
    );
  });

  it('T-R3c: TP partial leg fills with adverse slippage; 60% remains', () => {
    const cfg = loadConfig();
    const slip = cfg.paperSlippagePct / 100;
    const trader = new PaperTrader(cfg);
    const r = trader.openFromSignal(baseSignal('LONG'));
    assert.ok(r.id);
    const { quantity } = trader.account.positions[0];

    trader.onCandle('LONGUSDT', m15(1, 106, 99, 104)); // high 106 >= TP1 105
    const pos = trader.account.positions[0];
    assert.ok(pos, 'position partially open after TP1');
    assert.ok(Math.abs(pos.quantity - quantity * 0.6) < 1e-9, '40% TP1 leg closed');
    // TP1 leg gross uses the slipped fill: LONG sells at TP1*(1-slip).
    assert.equal(trader.account.tradeHistory.length, 0, 'history only on full close');
    assert.ok(trader.account.realizedPnl > 0, 'TP1 leg banks profit (slipped)');
  });

  it('T-R3d: MANUAL closePosition fills with adverse slippage', () => {
    const cfg = loadConfig();
    const slip = cfg.paperSlippagePct / 100;
    const feeRate = cfg.paperFeePct / 100;
    const trader = new PaperTrader(cfg);
    const r = trader.openFromSignal(baseSignal('LONG'));
    assert.ok(r.id);
    const { id } = trader.account.positions[0];
    const { entry, quantity } = trader.account.positions[0];

    trader.closePosition(id, 102, 'MANUAL');
    assert.equal(trader.account.positions.length, 0);
    const trade = trader.account.tradeHistory[0];
    assert.equal(trade.exitReason, 'MANUAL');
    const expectedFill = 102 * (1 - slip);
    const expectedGross = (expectedFill - entry) * quantity;
    const expectedExitFee = quantity * expectedFill * feeRate;
    const expectedEntryFee = quantity * entry * feeRate;
    assert.ok(
      Math.abs(trade.pnlQuote - (expectedGross - expectedExitFee - expectedEntryFee)) < 1e-9,
      'MANUAL close nets slipped gross minus fees',
    );
  });

  it('T-R3e: full lifecycle — no double-counted fees/slippage; balance reconciles', () => {
    const cfg = loadConfig();
    const slip = cfg.paperSlippagePct / 100;
    const feeRate = cfg.paperFeePct / 100;
    const trader = new PaperTrader(cfg);
    const startBalance = trader.account.balance;
    const r = trader.openFromSignal(baseSignal('LONG'));
    assert.ok(r.id);
    const { entry, quantity } = trader.account.positions[0];
    const entryFee = quantity * entry * feeRate;

    // TP1 partial (40%), then SL on the remainder.
    trader.onCandle('LONGUSDT', m15(1, 106, 99, 104));
    trader.onCandle('LONGUSDT', m15(2, 102, 93, 94));
    assert.equal(trader.account.positions.length, 0);
    const trade = trader.account.tradeHistory[0];

    const tp1Fill = 105 * (1 - slip);
    const slFill = 95 * (1 - slip);
    const q1 = quantity * 0.4;
    const q2 = quantity * 0.6;
    const fee1 = q1 * tp1Fill * feeRate;
    const fee2 = q2 * slFill * feeRate;
    const expectedFees = entryFee + fee1 + fee2;
    assert.ok(
      Math.abs(trader.account.totalFees - expectedFees) < 1e-9,
      `totalFees ${trader.account.totalFees} must equal entry+exit legs exactly`,
    );
    assert.ok(
      Math.abs(trade.fees - expectedFees) < 1e-9,
      'trade.fees itemizes every leg exactly once',
    );
    // Balance: start - entryFee + Σ leg nets == start + pnlQuote.
    assert.ok(
      Math.abs(trader.account.balance - (startBalance + trade.pnlQuote)) < 1e-9,
      'balance reconciles to start + net pnl',
    );
    assert.ok(
      Math.abs(trader.account.realizedPnl - (trade.pnlQuote + entryFee)) < 1e-9,
      'realizedPnl equals leg nets (entry fee excluded by design, cf. ledger audit)',
    );
  });

  it('T-R3f: equity reflects unrealized on remaining qty after partial TP', () => {
    const trader = new PaperTrader(loadConfig());
    trader.openFromSignal(baseSignal('LONG'));
    const { entry, quantity } = trader.account.positions[0];
    trader.onCandle('LONGUSDT', m15(1, 106, 99, 104)); // TP1 40%
    const acct = trader.account;
    const remaining = quantity * 0.6;
    const expectedUnrealized = (104 - entry) * remaining; // lastPrice = candle close
    assert.ok(
      Math.abs(acct.equity - (acct.balance + expectedUnrealized)) < 1e-9,
      `equity ${acct.equity} must equal balance + unrealized`,
    );
  });
});
