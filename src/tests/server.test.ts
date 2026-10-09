/** Unit tests: server — validation, JSON errors, and rate limiting. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, isValidSymbol } from '../server';
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
});
