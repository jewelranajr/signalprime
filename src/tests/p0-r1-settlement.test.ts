/** P0 R1 regression tests: post-entry settlement guard.
 * A candle that ended at or before a position opened must never close it.
 * Includes the live DOGEUSDT stale-candle scenario (exit 23.5h before entry).
 * Deterministic: fixed timestamps, no randomness, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader, type PaperCandle } from '../paper';
import { loadConfig } from '../config';
import type { MasterSignal } from '../types';

// Fixed "now" for the suite: 2026-10-22 21:30:59 +06 (DOGEUSDT entry, approx).
const T = 1792683059000;
const MIN15 = 15 * 60 * 1000;

function makeShortSignal(createdAtMs: number): MasterSignal {
  return {
    signal_id: 'R1-TEST',
    symbol: 'DOGEUSDT',
    direction: 'SHORT',
    status: 'ACTIVE',
    signal_grade: 'A',
    long_score: 20,
    short_score: 86,
    confidence: 82,
    probability_estimate: 70,
    probability_note: 'test',
    market_regime: 'WEAK_BEAR',
    entry: { low: 99, high: 101, preferred: 100, type: 'MARKET', reason: 'test' },
    stop_loss: { price: 105, distance_percent: 5, reason: 'test' },
    take_profit: { tp1: 95, tp2: 90, tp3: 85, reasons: [] },
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
    created_at: new Date(createdAtMs).toISOString(),
    expires_at: new Date(createdAtMs + 3600_000).toISOString(),
  };
}

function m15(openTime: number, high: number, low: number, close: number, withCloseTime = true): PaperCandle {
  const c: PaperCandle = { openTime, open: 100, high, low, close, closeTime: openTime + MIN15 - 1 };
  if (!withCloseTime) delete c.closeTime;
  return c;
}

function openShort(t: PaperTrader): { entry: number; quantity: number } {
  const r = t.openFromSignal(makeShortSignal(T));
  assert.ok(r.id, 'position should open');
  const pos = t.account.positions[0];
  assert.equal(pos.openedAt, T);
  return { entry: pos.entry, quantity: pos.quantity };
}

describe('P0 R1: historical candles cannot settle a position opened after them', () => {
  it('T-R1a (DOGEUSDT scenario): a 15m candle from 23.5h before entry cannot SL-close the position', () => {
    const trader = new PaperTrader(loadConfig());
    openShort(trader);
    const balanceAfterOpen = trader.account.balance;

    // Stale candle: Oct 21 21:45–22:00 15m bar whose wick pierces the SL.
    const stale = m15(T - 24 * 3600_000, /*high*/ 106, /*low*/ 100, /*close*/ 102);
    assert.ok(stale.closeTime! < T, 'stale candle must predate the open');
    trader.onCandle('DOGEUSDT', stale);

    assert.equal(trader.account.positions.length, 1, 'position must still be open');
    assert.equal(trader.account.tradeHistory.length, 0, 'no trade may be recorded');
    assert.equal(trader.account.balance, balanceAfterOpen, 'balance untouched by stale candle');
  });

  it('T-R1b: a post-open 15m candle piercing the SL closes at the candle closeTime', () => {
    const trader = new PaperTrader(loadConfig());
    const { entry, quantity } = openShort(trader);

    const c = m15(T + 3600_000, /*high*/ 106, /*low*/ 100, /*close*/ 104);
    assert.ok(c.closeTime! > T);
    trader.onCandle('DOGEUSDT', c);

    assert.equal(trader.account.positions.length, 0, 'position closed');
    assert.equal(trader.account.tradeHistory.length, 1);
    const trade = trader.account.tradeHistory[0];
    assert.equal(trade.exitReason, 'SL');
    assert.equal(trade.exitTime, c.closeTime, 'exitTime is the triggering candle closeTime');
    // Exact internal consistency (R3: exits fill with adverse slippage).
    // SHORT SL fill = SL * (1 + slip); fees on actual notionals; nothing double-counted.
    const slip = loadConfig().paperSlippagePct / 100;
    const slFill = 105 * (1 + slip);
    const expectedGross = -(slFill - entry) * quantity;
    const expectedExitFee = quantity * slFill * 0.0005;
    const expectedEntryFee = trade.fees - expectedExitFee;
    assert.ok(expectedEntryFee > 0, 'entry fee accounted');
    assert.ok(
      Math.abs(trade.pnlQuote - (expectedGross - expectedExitFee - expectedEntryFee)) < 1e-9,
      `pnlQuote ${trade.pnlQuote} must equal gross-fees exactly`,
    );
  });

  it('T-R1c: boundary — candle with closeTime exactly == openedAt is skipped', () => {
    const trader = new PaperTrader(loadConfig());
    openShort(trader);
    const c = m15(T - MIN15 + 1, /*high*/ 106, /*low*/ 100, /*close*/ 102);
    // Force closeTime to exactly T.
    (c as { closeTime: number }).closeTime = T;
    trader.onCandle('DOGEUSDT', c);
    assert.equal(trader.account.positions.length, 1);
    assert.equal(trader.account.tradeHistory.length, 0);
  });

  it('T-R1d: candle without closeTime falls back to openTime', () => {
    const trader = new PaperTrader(loadConfig());
    openShort(trader);
    // Pre-open by openTime → skipped even though closeTime is absent.
    trader.onCandle('DOGEUSDT', m15(T - 3600_000, 106, 100, 102, false));
    assert.equal(trader.account.positions.length, 1);
    assert.equal(trader.account.tradeHistory.length, 0);
    // Post-open by openTime → processed, SL fires.
    trader.onCandle('DOGEUSDT', m15(T + 3600_000, 106, 100, 104, false));
    assert.equal(trader.account.positions.length, 0);
    assert.equal(trader.account.tradeHistory[0].exitReason, 'SL');
  });

  it('T-R1e: pre-open TP touch blocked; post-open TP touch fires the 40% leg', () => {
    const trader = new PaperTrader(loadConfig());
    const { quantity } = openShort(trader);
    // SHORT TP1 = 95 → touched when candle.low <= 95.
    trader.onCandle('DOGEUSDT', m15(T - 3600_000, 101, 94, 96));
    assert.equal(trader.account.positions.length, 1, 'pre-open TP touch must not fire');
    assert.equal(trader.account.tradeHistory.length, 0);

    trader.onCandle('DOGEUSDT', m15(T + 3600_000, 101, 94, 96));
    const pos = trader.account.positions[0];
    assert.ok(pos, 'position partially open after TP1');
    assert.ok(
      Math.abs(pos.quantity - quantity * 0.6) < 1e-9,
      `remaining qty must be 60% after the 40% TP1 leg (got ${pos.quantity})`,
    );
  });

  it('T-R1f: skipped candles do not pollute lastPrice (equity stays consistent)', () => {
    const trader = new PaperTrader(loadConfig());
    const { entry } = openShort(trader);
    // Feed several stale candles with wild closes.
    for (let k = 1; k <= 5; k++) {
      trader.onCandle('DOGEUSDT', m15(T - k * 3600_000, 106, 99, 50 + k));
    }
    const acct = trader.account;
    assert.equal(acct.positions.length, 1, 'stale candles must not close the position');
    // lastPrice must still be the fill price → unrealized == 0 → equity == balance.
    assert.ok(
      Math.abs(acct.equity - acct.balance) < 1e-9,
      `equity ${acct.equity} must equal balance ${acct.balance} (lastPrice == fill ${entry})`,
    );
  });

  it('T-R1g: replaying the full 24h window (96x15m) after open never backdates an exit', () => {
    const trader = new PaperTrader(loadConfig());
    openShort(trader);
    // Simulate the runner's settle: 96 fifteen-minute candles ending at T+15m,
    // i.e. 24h of history including candles far older than the position.
    for (let k = 96; k >= 1; k--) {
      const openTime = T + MIN15 - k * MIN15;
      // Every 10th historical candle pierces the SL — the old code closed here.
      const pierces = k % 10 === 0;
      trader.onCandle(
        'DOGEUSDT',
        m15(openTime, pierces ? 106 : 101, 99, 100),
      );
    }
    assert.equal(trader.account.positions.length, 1, 'no stale candle may close the position');
    assert.equal(trader.account.tradeHistory.length, 0);
    // The only candle that may act is the one containing/after the open (k=1:
    // openTime == T, closeTime == T+MIN15-1 > T) — it did not pierce, so still open.
  });
});
