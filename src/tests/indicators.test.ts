/** Unit tests: indicators — correctness, bounds, and causality (no look-ahead). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ema,
  rsi,
  macd,
  atr,
  adx,
  vwap,
  bollinger,
  sma,
  swingPoints,
  supportResistance,
  marketStructure,
  detectBOS,
  computeIndicators,
  lastFinite,
} from '../indicators';
import { makeCandles } from './helpers';

describe('indicators', () => {
  it('ema: seeds with SMA and follows the textbook recursion', () => {
    const e = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    assert.ok(Number.isNaN(e[0]) && Number.isNaN(e[1]), 'prefix is NaN');
    assert.equal(e[2], 2); // SMA(1,2,3)
    assert.equal(e[3], 3); // 4*0.5 + 2*0.5
    assert.equal(e[9], 9);
  });

  it('rsi: all-up series -> 100, all-down -> 0, always bounded', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 140 - i);
    const rUp = lastFinite(rsi(up));
    const rDown = lastFinite(rsi(down));
    assert.ok(rUp > 99 && rUp <= 100, `rsi up = ${rUp}`);
    assert.ok(rDown >= 0 && rDown < 1, `rsi down = ${rDown}`);
    const mixed = rsi(up.map((v, i) => (i % 2 === 0 ? v : v - 0.5)));
    for (const v of mixed) {
      if (Number.isFinite(v)) assert.ok(v >= 0 && v <= 100);
    }
  });

  it('is causal: truncating the series does not change earlier values (no look-ahead)', () => {
    const candles = makeCandles(120, { seed: 7 });
    const closes = candles.map((c) => c.close);
    const full = computeIndicators(candles);
    const part = computeIndicators(candles.slice(0, 60));
    const keys = ['ema20', 'ema50', 'rsi', 'atr', 'vwap', 'volumeSMA'] as const;
    for (const k of keys) {
      const a = full[k] as number[];
      const b = part[k] as number[];
      for (let i = 0; i < 60; i++) {
        const x = a[i];
        const y = b[i];
        if (Number.isNaN(x) && Number.isNaN(y)) continue;
        assert.equal(x, y, `${k}[${i}] changed when future data was added`);
      }
    }
    // macd/adx nested arrays too
    for (let i = 0; i < 60; i++) {
      assert.equal(full.macd.histogram[i], part.macd.histogram[i], `macd.histogram[${i}]`);
      assert.equal(full.adx.adx[i], part.adx.adx[i], `adx[${i}]`);
      assert.equal(full.bollinger.upper[i], part.bollinger.upper[i], `bb.upper[${i}]`);
    }
  });

  it('atr/adx/macd/bollinger produce finite values on real-ish data', () => {
    const candles = makeCandles(250, { seed: 11 });
    const ind = computeIndicators(candles);
    assert.ok(Number.isFinite(lastFinite(ind.atr)) && lastFinite(ind.atr) > 0);
    const adxV = lastFinite(ind.adx.adx);
    assert.ok(Number.isFinite(adxV) && adxV >= 0 && adxV <= 100);
    assert.ok(Number.isFinite(lastFinite(ind.macd.histogram)));
    const i = ind.bollinger.upper.length - 1;
    assert.ok(ind.bollinger.upper[i] > ind.bollinger.middle[i]);
    assert.ok(ind.bollinger.middle[i] > ind.bollinger.lower[i]);
    const vw = lastFinite(ind.vwap);
    const last = candles[candles.length - 1].close;
    assert.ok(vw > last * 0.5 && vw < last * 2, 'vwap in sane range');
  });

  it('sma matches hand computation', () => {
    assert.deepEqual(sma([1, 2, 3, 4], 2), [NaN, 1.5, 2.5, 3.5]);
  });

  it('swing points + market structure label valid HH/HL/LH/LL sequence', () => {
    const candles = makeCandles(300, { seed: 21, driftPct: 0.003, volPct: 0.004 });
    const { highs, lows } = swingPoints(candles, 2);
    assert.ok(highs.length > 5 && lows.length > 5);
    const struct = marketStructure(candles);
    assert.ok(struct.length > 0);
    for (const s of struct) {
      assert.ok(['HH', 'HL', 'LH', 'LL'].includes(s.label), `bad label ${s.label}`);
    }
  });

  it('support/resistance: uptrend yields support levels below price', () => {
    const candles = makeCandles(300, { seed: 33, driftPct: 0.003, volPct: 0.004 });
    const ind = computeIndicators(candles);
    const last = candles[candles.length - 1].close;
    assert.ok(ind.support.length > 0, 'expected support levels');
    assert.ok(ind.support.every((s) => s < last * 1.02), 'support near/below price');
  });

  it('detectBOS finds volume-confirmed UP breaks in a strong uptrend', () => {
    const candles = makeCandles(300, { seed: 44, driftPct: 0.004, volPct: 0.003 });
    const ind = computeIndicators(candles);
    const ups = ind.bos.filter((b) => b.direction === 'UP');
    assert.ok(ups.length > 0, 'expected at least one UP BOS');
  });

  it('computeIndicators never throws on tiny/degenerate input', () => {
    const ind = computeIndicators(makeCandles(5, { seed: 1 }));
    assert.ok(ind.ema200.every(Number.isNaN) || ind.ema200.length === 5);
    const empty = computeIndicators([]);
    assert.equal(empty.ema20.length, 0);
  });

  it('lastFinite returns NaN when nothing finite', () => {
    assert.ok(Number.isNaN(lastFinite([NaN, NaN])));
    assert.equal(lastFinite([NaN, 3, NaN]), 3);
  });
});
