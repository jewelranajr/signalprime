/** Unit tests: server — validation, JSON errors, and rate limiting. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, buildHonestLiveStats, isValidSymbol } from '../server';
import type { BacktestTrade } from '../types';
import { BinanceDataClient } from '../exchange';
import { CooldownTracker } from '../filters';
import { loadConfig } from '../config';
import type { MarketContext, MasterSignal } from '../types';

function testDeps() {
  const config = loadConfig();
  config.rateLimitMax = 3;
  config.rateLimitWindowMs = 60_000;
  const market: MarketContext = {
    btcRegime: 'SIDEWAYS',
    ethRegime: 'SIDEWAYS',
    btcChange24hPct: 0,
    ethChange24hPct: 0,
    btcViolentDump: false,
    btcStrongBull: false,
    ethViolentDump: false,
  };
  return {
    client: new BinanceDataClient(config),
    config,
    cooldowns: new CooldownTracker(config),
    getMarketContext: (): MarketContext => market,
    recordSignal: (_s: MasterSignal): void => undefined,
    activeSignals: (): MasterSignal[] => [],
  };
}

describe('server', () => {
  it('isValidSymbol: accepts BTCUSDT, rejects garbage', () => {
    assert.equal(isValidSymbol('BTCUSDT'), true);
    assert.equal(isValidSymbol('ETHUSDT'), true);
    assert.equal(isValidSymbol('btcusdt'), false);
    assert.equal(isValidSymbol('BTC-USDT'), false);
    assert.equal(isValidSymbol(''), false);
    assert.equal(isValidSymbol('BTCUSD'), false, 'must end with USDT');
    assert.equal(isValidSymbol('A'.repeat(21) + 'USDT'), false, 'too long');
  });

  it('/api/health returns valid JSON', async () => {
    const app = await buildApp(testDeps());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('rate limiting engages after max requests (regression: plugin must be awaited before routes)', async () => {
    const app = await buildApp(testDeps());
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await app.inject({ method: 'GET', url: '/api/health' })).statusCode);
    }
    const over = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.ok(codes.slice(3).every((c) => c === 429), `expected 429s, got ${codes.join(',')}`);
    const body = over.json() as { error: string };
    assert.ok(/rate limit/i.test(body.error), '429 carries a JSON error message');
  });

  it('unknown routes return JSON 404, never HTML', async () => {
    const app = await buildApp(testDeps());
    const res = await app.inject({ method: 'GET', url: '/nope' });
    await app.close();
    assert.equal(res.statusCode, 404);
    assert.doesNotThrow(() => res.json());
  });

  it('buildHonestLiveStats: empty -> NO_TRADES; small sample -> UNDER_TEST', () => {
    const empty = buildHonestLiveStats([], 10_000);
    assert.equal(empty.status, 'NO_TRADES');
    assert.equal(empty.sampleTrades, 0);
    assert.equal(empty.winRatePct, null);
    const mk = (pnl: number, i: number): BacktestTrade => ({
      symbol: 'TUSDT', direction: 'LONG', grade: 'A', entry: 100, stopLoss: 95,
      takeProfits: [105], entryTime: i, exitTime: i + 1, exitReason: 'SL',
      pnlPct: pnl / 100, pnlQuote: pnl, rrRealized: 0, fees: 1,
    });
    const small = buildHonestLiveStats([mk(50, 1), mk(-30, 2), mk(10, 3)], 10_000);
    assert.equal(small.status, 'UNDER_TEST');
    assert.equal(small.sampleTrades, 3);
    assert.equal(Math.round(small.winRatePct!), 67);
    assert.equal(small.expectancyQuote, 10); // (50-30+10)/3, fee-inclusive via pnlQuote
    assert.equal(small.netPnlQuote, 30);
    assert.equal(small.totalFeesQuote, 3);
    assert.ok((small.maxDrawdownPct ?? 0) >= 0);
    assert.ok(small.notes.some((n) => /too small/.test(n)));
  });

  it('buildHonestLiveStats: 30+ losing trades -> NO_EDGE', () => {
    const mk = (i: number): BacktestTrade => ({
      symbol: 'TUSDT', direction: 'LONG', grade: 'A', entry: 100, stopLoss: 95,
      takeProfits: [105], entryTime: i, exitTime: i + 1, exitReason: 'SL',
      pnlPct: -1, pnlQuote: -100, rrRealized: 0, fees: 1,
    });
    const r = buildHonestLiveStats(Array.from({ length: 30 }, (_, i) => mk(i)), 10_000);
    assert.equal(r.status, 'NO_EDGE');
    assert.equal(r.expectancyQuote, -100);
    assert.ok((r.maxDrawdownPct ?? 0) > 20, 'steady losses draw down');
  });

  it('/api/validation returns live stats + backtest summary', async () => {
    const app = await buildApp(testDeps());
    const res = await app.inject({ method: 'GET', url: '/api/validation' });
    await app.close();
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      paperOnly: boolean; live: { status: string }; backtests: { runs: unknown[]; conclusion: string };
    };
    assert.equal(body.paperOnly, true);
    assert.ok(body.live && typeof body.live.status === 'string');
    assert.equal(body.backtests.runs.length, 5);
    assert.ok(/0 edges found/.test(body.backtests.conclusion));
  });
});
