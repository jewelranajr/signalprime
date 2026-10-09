/** Unit tests: filters — validation, liquidity, tiers, cooldowns, AI layer, repo hygiene. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  validateCandleData,
  checkLiquidity,
  correlationScore,
  gradeSignal,
  aiConfirm,
  defaultInvalidation,
  CooldownTracker,
} from '../filters';
import type { AIFeatures, Candle, MasterSignal } from '../types';
import { makeCandles, strictConfig, neutralMarket } from './helpers';
import { noTradeSignal } from '../engine';

function bullishFeatures(): AIFeatures {
  return {
    mtfScore: 60,
    longScore: 90,
    shortScore: 25,
    regime: 'STRONG_BULL',
    rsi: 62,
    macdHist: 1.5,
    adx: 30,
    volumeRatio: 1.8,
    vwapPosition: 'ABOVE',
    atrPct: 0.01,
    liquidityScore: 90,
    btcViolentDump: false,
    btcStrongBull: false,
    rr: 3,
  };
}

describe('filters', () => {
  it('validateCandleData: drops bad rows, dedupes, sorts', () => {
    const good = makeCandles(50, { seed: 3 });
    const dup = { ...good[10] };
    const bad: Candle = { ...good[20], high: 1, low: 2 }; // high < low
    const nan: Candle = { ...good[21], close: NaN };
    const rows = [...good.slice(0, 25), dup, bad, nan, ...good.slice(25)];
    const v = validateCandleData(rows);
    assert.ok(v.dropped >= 3, `dropped=${v.dropped}`);
    assert.equal(v.candles.length, 50);
    for (let i = 1; i < v.candles.length; i++) {
      assert.ok(v.candles[i].openTime > v.candles[i - 1].openTime, 'sorted, deduped');
    }
  });

  it('checkLiquidity rejects low volume / wide spread, accepts healthy market', () => {
    const cfg = strictConfig();
    const candles = makeCandles(100, { seed: 4 });
    const bad = checkLiquidity(candles, 10_000, 0.5, cfg);
    assert.equal(bad.ok, false);
    assert.ok(bad.issues.some((i) => /volume/i.test(i)));
    assert.ok(bad.issues.some((i) => /spread/i.test(i)));
    // Wick-trimmed series: no single heuristic tripwire should fire.
    const clean = candles.map((c) => ({
      ...c,
      high: Math.max(c.open, c.close) * 1.0005,
      low: Math.min(c.open, c.close) * 0.9995,
    }));
    const good = checkLiquidity(clean, 50_000_000, 0.01, cfg);
    assert.deepEqual(good.issues, [], `issues=${good.issues.join(';')}`);
    assert.equal(good.ok, true);
    assert.equal(good.score, 100);
  });

  it('gradeSignal: A+ needs everything; weak scores stay NO_TRADE; B never auto-trades', () => {
    const cfg = strictConfig();
    const mtf = {
      views: {},
      weightedScore: 60,
      htfBias: 'BULLISH',
      agreement: 85,
      confirmsLong: true,
      confirmsShort: false,
    } as unknown as import('../types').MTFAnalysis;
    const liq: import('../types').LiquidityCheck = {
      ok: true,
      quoteVolume24h: 50_000_000,
      spreadPct: 0.01,
      score: 95,
      issues: [],
    };
    assert.equal(gradeSignal(95, 20, 90, 3.0, mtf, liq, cfg), 'A+');
    assert.equal(gradeSignal(86, 20, 82, 2.1, mtf, liq, cfg), 'A');
    assert.equal(gradeSignal(95, 20, 90, 3.0, mtf, { ...liq, score: 50 }, cfg), 'A', 'weak liquidity blocks A+');
    assert.equal(gradeSignal(95, 20, 90, 3.0, { ...mtf, agreement: 40 }, liq, cfg), 'A', 'weak MTF agreement blocks A+');
    assert.equal(gradeSignal(50, 20, 90, 3.0, mtf, liq, cfg), 'NO_TRADE');
    assert.equal(gradeSignal(86, 20, 70, 2.1, mtf, liq, cfg), 'B', 'B tier exists but must not auto-trade');
  });

  it('aiConfirm: bullish features -> AI_BULLISH; BTC violent dump vetoes to NEUTRAL; deterministic', () => {
    const bull = aiConfirm(bullishFeatures());
    assert.equal(bull, 'AI_BULLISH');
    const vetoed = aiConfirm({ ...bullishFeatures(), btcViolentDump: true });
    assert.equal(vetoed, 'AI_NEUTRAL', 'dump veto demotes bullish');
    assert.equal(aiConfirm(bullishFeatures()), bull, 'pure function');
    const bearish: AIFeatures = {
      ...bullishFeatures(),
      mtfScore: -60,
      longScore: 25,
      shortScore: 90,
      regime: 'STRONG_BEAR',
      rsi: 35,
      macdHist: -1.5,
      vwapPosition: 'BELOW',
    };
    assert.equal(aiConfirm(bearish), 'AI_BEARISH');
  });

  it('CooldownTracker blocks rapid duplicates, allows after cooldown', () => {
    const cfg = strictConfig();
    const t = new CooldownTracker(cfg);
    const s = noTradeSignal('BTCUSDT', ['test']);
    const sig: MasterSignal = { ...s, direction: 'LONG', status: 'ACTIVE', market_regime: 'STRONG_BULL' };
    const now = Date.now();
    t.record(sig);
    const blocked = t.canEmit('BTCUSDT', 'LONG', 'STRONG_BULL', now + 1000);
    assert.equal(blocked.ok, false, 'same-direction cooldown blocks');
    assert.ok(blocked.reason && blocked.reason.length > 0);
    const other = t.canEmit('ETHUSDT', 'LONG', 'STRONG_BULL', now + 1000);
    assert.equal(other.ok, true, 'other symbols unaffected');
    const later = t.canEmit('BTCUSDT', 'LONG', 'STRONG_BULL', now + cfg.sameDirectionCooldownMs + 1000);
    assert.equal(later.ok, true, 'cooldown expires');
  });

  it('correlationScore is the same-direction share', () => {
    assert.equal(correlationScore(0, 0), 0);
    assert.equal(correlationScore(3, 4), 75);
  });

  it('defaultInvalidation returns direction-appropriate checklists', () => {
    const l = defaultInvalidation('LONG');
    const s = defaultInvalidation('SHORT');
    assert.ok(l.length > 0 && s.length > 0);
    assert.ok(l.some((x) => /below/i.test(x)));
    assert.ok(s.some((x) => /above/i.test(x)));
  });

  it('repo hygiene: no accuracy-guarantee language anywhere in src', () => {
    const root = path.resolve(__dirname, '..', '..', 'src');
    const offenders: string[] = [];
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith('.ts')) continue;
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      // Any "100%" claim is forbidden outright.
      const pct = [...text.matchAll(/\b100\s*%/g)];
      for (const m of pct) offenders.push(`${f}: "100%" claim near: ...${text.slice(Math.max(0, m.index - 40), m.index + 40)}...`);
      // "guaranteed ..." is only acceptable inside an explicit disclaimer
      // (a negation word within the preceding 120 chars).
      for (const m of text.matchAll(/\bguarantee\w*\b/gi)) {
        const ctx = text.slice(Math.max(0, m.index - 120), m.index).toLowerCase();
        if (!/(never|not|nothing|without|no\b|n't)\b/.test(ctx)) {
          offenders.push(`${f}: non-disclaimer "guarantee" near: ...${text.slice(Math.max(0, m.index - 40), m.index + 40)}...`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'accuracy-guarantee language found');
  });

  it('neutralMarket helper sanity', () => {
    const m = neutralMarket();
    assert.equal(m.btcViolentDump, false);
  });
});
