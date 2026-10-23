/** P0 R4 regression tests: dynamic risk sizing off live equity.
 * Position sizing must use current paper equity (balance + unrealized), not a
 * static $10,000 config value — risk compounds on wins and shrinks on losses.
 * Deterministic: synthetic fixtures, no randomness, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../paper';
import { buildSignal } from '../engine';
import { sizePosition } from '../risk';
import { loadConfig } from '../config';
import {
  makeCandles,
  singleTFInput,
  neutralMarket,
  relaxedConfig,
  trendFixture,
} from './helpers';
import type { EngineDeps, MasterSignal } from '../types';

function deps(balance: number, now: number): EngineDeps {
  return { config: relaxedConfig(), market: neutralMarket(), balance, now };
}

function longSignal(): MasterSignal {
  const candles = trendFixture(21, 0.002);
  const s = buildSignal(
    singleTFInput('BTCUSDT', candles),
    deps(10_000, candles[399].closeTime),
  );
  assert.equal(s.direction, 'LONG', `fixture must give LONG, got ${s.direction}`);
  assert.ok(s.position, 'LONG signal must carry a position plan');
  return s;
}

/** Manual ACTIVE/MARKET LONG for lifecycle tests (isolates sizing from engine entry logic). */
function manualLong(symbol = 'BTCUSDT'): MasterSignal {
  return {
    signal_id: 'R4-MANUAL',
    symbol,
    direction: 'LONG',
    status: 'ACTIVE',
    signal_grade: 'A',
    long_score: 86,
    short_score: 20,
    confidence: 82,
    probability_estimate: 70,
    probability_note: 'test',
    market_regime: 'WEAK_BULL',
    entry: { low: 99, high: 101, preferred: 100, type: 'MARKET', reason: 'test' },
    stop_loss: { price: 95, distance_percent: 5, reason: 'test' },
    take_profit: { tp1: 105, tp2: 110, tp3: 120, reasons: [] },
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

const T0 = 1_700_000_000_000;
const MIN15 = 15 * 60 * 1000;

function m15(k: number, high: number, low: number, close: number) {
  const openTime = T0 + k * MIN15;
  return { openTime, open: 100, high, low, close, closeTime: openTime + MIN15 - 1 };
}

describe('P0 R4: risk sized off live equity, not static balance', () => {
  it('T-R4a: sizePosition scales risk_amount with the passed balance (unit)', () => {
    const r1 = sizePosition(10_000, 1, 100, 95, 2);
    assert.equal(r1.risk_amount, 100);
    const r2 = sizePosition(9_000, 1, 100, 95, 2);
    assert.equal(r2.risk_amount, 90, 'risk shrinks with equity');
    const r3 = sizePosition(11_000, 1, 100, 95, 2);
    assert.equal(r3.risk_amount, 110, 'risk compounds with equity');
    // Quantity follows: qty = risk_amount / |entry - SL|.
    assert.ok(Math.abs(r2.quantity - 90 / 5) < 1e-9);
    assert.ok(Math.abs(r3.quantity - 110 / 5) < 1e-9);
  });

  it('T-R4b: buildSignal honors deps.balance for the position plan (wiring)', () => {
    const candles = trendFixture(21, 0.002);
    const input = singleTFInput('BTCUSDT', candles);
    const now = candles[399].closeTime;
    const s9k = buildSignal(input, deps(9_000, now));
    const s11k = buildSignal(input, deps(11_000, now));
    assert.ok(s9k.position && s11k.position, 'both must carry position plans');
    assert.equal(s9k.position.risk_amount, 90, 'risk_amount follows deps.balance');
    assert.equal(s11k.position.risk_amount, 110);
    assert.ok(
      s9k.position.quantity < s11k.position.quantity,
      'quantity scales with balance',
    );
  });

  it('T-R4c: after a loss, trader equity drops and the next planned risk drops with it', () => {
    const cfg = loadConfig();
    const trader = new PaperTrader(cfg);
    assert.equal(trader.account.equity, 10_000, 'fresh equity is $10k');

    // Open and stop out a LONG: equity must fall below $10k.
    const opened = trader.openFromSignal(manualLong());
    assert.ok(opened.id, 'position opens');
    // Feed a post-open 15m candle through the SL (95).
    trader.onCandle('BTCUSDT', m15(1, 101, 90, 92));
    assert.equal(trader.account.tradeHistory.length, 1);
    const equity = trader.account.equity;
    assert.ok(equity < 10_000, `equity ${equity} must drop after the SL loss`);

    // What the runner now passes as deps.balance:
    const planned = sizePosition(equity, cfg.riskPercent, 100, 95, 2);
    assert.ok(
      planned.risk_amount < 100,
      `planned risk ${planned.risk_amount} must be < $100 on reduced equity`,
    );
    assert.ok(
      Math.abs(planned.risk_amount - (equity * cfg.riskPercent) / 100) < 1e-9,
      'risk_amount is exactly equity * riskPercent / 100',
    );
  });

  it('T-R4d: openFromSignal never risks more than the signal plannedRisk', () => {
    const trader = new PaperTrader(loadConfig());
    const sig = manualLong();
    // Simulate reduced equity: shrink the planned risk and quantity.
    const small = sizePosition(5_000, 1, 100, 95, 2);
    const posPlan = sig.position;
    assert.ok(posPlan, 'manual signal carries a position plan');
    posPlan.risk_amount = small.risk_amount; // $50
    posPlan.quantity = small.quantity; // 10
    const r = trader.openFromSignal(sig);
    assert.ok(r.id, 'opens');
    const pos = trader.account.positions[0];
    const actualRisk = pos.quantity * Math.abs(pos.entry - pos.stopLoss);
    assert.ok(
      actualRisk <= 50 + 1e-9,
      `actual risk ${actualRisk} must not exceed planned $50`,
    );
  });

  it('T-R4e: equity includes unrealized — winners raise subsequent risk', () => {
    const cfg = loadConfig();
    const trader = new PaperTrader(cfg);
    const opened = trader.openFromSignal(manualLong());
    assert.ok(opened.id);
    const { entry, quantity } = trader.account.positions[0];
    // Favorable 15m candle, no SL/TP touch: equity > balance.
    trader.onCandle('BTCUSDT', m15(1, 103, 99, 103));
    assert.equal(trader.account.positions.length, 1, 'still open');
    const { equity, balance } = trader.account;
    assert.ok(equity > balance, `equity ${equity} > balance ${balance} on unrealized gain`);
    const planned = sizePosition(equity, cfg.riskPercent, 100, 95, 2);
    assert.ok(planned.risk_amount > 100, 'risk compounds on unrealized gains');
    // Sanity: unrealized matches the position math.
    const expectedUnrealized = (103 - entry) * quantity;
    assert.ok(Math.abs(equity - (balance + expectedUnrealized)) < 1e-9);
  });
});
