/** Unit tests: Time Machine — setup replay, settlement, and stats. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import type { PaperCandle } from '../paper';
import {
  simulateSetupHistory,
  type TimeMachineSetup,
} from '../timemachine';

const H4 = 4 * 3_600_000;
const T0 = 1_700_000_000_000;

function bar(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
): PaperCandle {
  return {
    openTime: T0 + i * H4,
    open,
    high,
    low,
    close,
    closeTime: T0 + (i + 1) * H4 - 1,
  };
}

const LONG_SETUP: TimeMachineSetup = {
  symbol: 'BTCUSDT',
  direction: 'LONG',
  slPct: 2,
  tp1Pct: 2,
  tp2Pct: 4,
  tp3Pct: 6,
};

describe('timemachine', () => {
  it('SL hit closes the full size at a loss beyond planned risk (fees + slippage)', () => {
    const config = loadConfig();
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 100, 97, 98),
    ];
    const res = simulateSetupHistory(candles, LONG_SETUP, config, {
      riskPerTradeUsd: 100,
    });
    assert.equal(res.n, 1);
    assert.equal(res.trades[0].exitReason, 'SL');
    // Planned risk 100 + entry/exit fees + adverse slippage.
    assert.ok(res.trades[0].pnlQuote < -100, `pnl=${res.trades[0].pnlQuote}`);
    assert.ok(res.trades[0].pnlQuote > -110, `pnl=${res.trades[0].pnlQuote}`);
    assert.ok(res.totalFees > 0);
  });

  it('partial TP then hold-window expiry aggregates into one EXPIRED trade', () => {
    const config = loadConfig();
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 103, 100, 101),
    ];
    const res = simulateSetupHistory(candles, LONG_SETUP, config, {
      riskPerTradeUsd: 100,
      maxHoldBars: 1,
    });
    assert.equal(res.n, 1);
    assert.equal(res.trades[0].exitReason, 'EXPIRED');
    // 40% closed at TP1 (102) for a profit, 60% at 101: net positive.
    assert.ok(res.trades[0].pnlQuote > 0, `pnl=${res.trades[0].pnlQuote}`);
  });

  it('SHORT mirrors LONG: a rise through the stop is an SL loss', () => {
    const config = loadConfig();
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 103, 100, 102),
    ];
    const res = simulateSetupHistory(
      candles,
      { ...LONG_SETUP, direction: 'SHORT' },
      config,
      { riskPerTradeUsd: 100 },
    );
    assert.equal(res.n, 1);
    assert.equal(res.trades[0].exitReason, 'SL');
    assert.ok(res.trades[0].pnlQuote < -100);
  });

  it('flat market with no touch expires at maxHoldBars', () => {
    const config = loadConfig();
    const candles = [
      bar(0, 100, 100.5, 99.5, 100),
      bar(1, 100, 100.5, 99.5, 100),
      bar(2, 100, 100.5, 99.5, 100),
      bar(3, 100, 100.5, 99.5, 100),
      bar(4, 100, 100.5, 99.5, 100),
    ];
    const res = simulateSetupHistory(candles, LONG_SETUP, config, {
      riskPerTradeUsd: 100,
      maxHoldBars: 2,
    });
    assert.equal(res.n, 4); // entries at bars 0..3
    assert.ok(res.trades.every((t) => t.exitReason === 'EXPIRED'));
    // No price move: only fees lost.
    assert.ok(res.trades[0].pnlQuote < 0 && res.trades[0].pnlQuote > -10);
  });

  it('rising staircase: every setup wins and passes the historical gate', () => {
    const config = loadConfig();
    const candles: PaperCandle[] = [];
    let price = 100;
    for (let i = 0; i < 40; i++) {
      const open = price;
      const close = price * 1.01;
      candles.push(bar(i, open, close * 1.002, open * 0.998, close));
      price = close;
    }
    const res = simulateSetupHistory(candles, LONG_SETUP, config, {
      riskPerTradeUsd: 100,
    });
    assert.equal(res.n, 39);
    assert.equal(res.winRate, 1);
    assert.equal(res.profitFactor, 99); // no losing trades
    assert.ok(res.expectancy > 0);
    assert.equal(res.verdict, 'PASSES_HISTORICAL_GATE');
    assert.deepEqual(res.verdictReasons, []);
  });

  it('falling staircase: every LONG setup stops out and fails the gate', () => {
    const config = loadConfig();
    const candles: PaperCandle[] = [];
    let price = 100;
    for (let i = 0; i < 40; i++) {
      const open = price;
      const close = price * 0.99;
      candles.push(bar(i, open, open * 1.002, close * 0.998, close));
      price = close;
    }
    const res = simulateSetupHistory(candles, LONG_SETUP, config, {
      riskPerTradeUsd: 100,
    });
    assert.equal(res.n, 39);
    assert.equal(res.winRate, 0);
    assert.equal(res.profitFactor, 0);
    assert.ok(res.expectancy < 0);
    assert.equal(res.verdict, 'DOES_NOT_PASS');
    assert.ok(res.verdictReasons.length > 0);
  });

  it('empty history yields zero trades without crashing', () => {
    const config = loadConfig();
    const res = simulateSetupHistory([], LONG_SETUP, config);
    assert.equal(res.n, 0);
    assert.equal(res.candlesUsed, 0);
    assert.equal(res.verdict, 'DOES_NOT_PASS');
  });

  it('invalid setups throw', () => {
    const config = loadConfig();
    const candles = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100)];
    assert.throws(() =>
      simulateSetupHistory(candles, { ...LONG_SETUP, slPct: 0 }, config),
    );
    assert.throws(() =>
      simulateSetupHistory(
        candles,
        { ...LONG_SETUP, tp1Pct: 6, tp2Pct: 4, tp3Pct: 2 },
        config,
      ),
    );
    assert.throws(() =>
      simulateSetupHistory(
        candles,
        { ...LONG_SETUP, direction: 'NO_TRADE' as 'LONG' },
        config,
      ),
    );
  });
});
