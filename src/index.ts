/**
 * CryptoAI Pro — Master Signal Engine bootstrap.
 *
 * Wires the public-market-data client, cooldown tracker, market-context cache,
 * and active-signal store into the Fastify API. No secrets exist in this
 * system: only Binance PUBLIC market-data endpoints are used.
 */
import { loadConfig } from './config';
import { BinanceDataClient } from './exchange';
import { CooldownTracker, buildMarketContext } from './filters';
import { buildApp } from './server';
import type { MarketContext, MasterSignal } from './types';

const MARKET_CONTEXT_TTL_MS = 5 * 60 * 1000; // refresh at most every 5 minutes

/** Safe fallback when no market context has ever been fetched successfully. */
const NEUTRAL_CONTEXT: MarketContext = {
  btcRegime: 'SIDEWAYS',
  ethRegime: 'SIDEWAYS',
  btcChange24hPct: 0,
  ethChange24hPct: 0,
  btcViolentDump: false,
  btcStrongBull: false,
  ethViolentDump: false,
};

function isExpired(sig: MasterSignal, now: number): boolean {
  const t = Date.parse(sig.expires_at);
  return !Number.isFinite(t) || t <= now;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new BinanceDataClient(config);
  const cooldowns = new CooldownTracker(config);

  // ---- Market-context cache (BTC/ETH 1h regimes + 24h changes) ------------
  let cached: { ctx: MarketContext; ts: number } | null = null;
  let refreshInFlight: Promise<void> | null = null;

  async function refreshMarketContext(): Promise<void> {
    if (cached && Date.now() - cached.ts < MARKET_CONTEXT_TTL_MS) return;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const [btcCandles, ethCandles, btcTicker, ethTicker] = await Promise.all([
        client.getKlines('BTCUSDT', '1h', 250),
        client.getKlines('ETHUSDT', '1h', 250),
        client.getTicker24h('BTCUSDT'),
        client.getTicker24h('ETHUSDT'),
      ]);
      cached = {
        ctx: buildMarketContext(
          btcCandles,
          ethCandles,
          btcTicker?.priceChangePct,
          ethTicker?.priceChangePct,
        ),
        ts: Date.now(),
      };
    })();
    try {
      await refreshInFlight;
    } catch (err) {
      // Keep last known context; fall back to neutral on first boot.
      console.warn(
        '[market-context] refresh failed, keeping last known:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      refreshInFlight = null;
    }
  }

  function getMarketContext(): MarketContext {
    // Lazy fire-and-forget refresh; always return synchronously.
    void refreshMarketContext();
    return cached?.ctx ?? NEUTRAL_CONTEXT;
  }

  // ---- Active signals (keyed by symbol, pruned of expired entries) --------
  const active = new Map<string, MasterSignal>();

  function pruneExpired(): void {
    const now = Date.now();
    for (const [key, sig] of active) {
      if (isExpired(sig, now)) active.delete(key);
    }
  }

  function recordSignal(signal: MasterSignal): void {
    pruneExpired();
    active.set(signal.symbol, signal);
  }

  function activeSignals(): MasterSignal[] {
    pruneExpired();
    return [...active.values()];
  }

  // ---- Build + start -------------------------------------------------------
  const app = await buildApp({
    client,
    config,
    cooldowns,
    getMarketContext,
    recordSignal,
    activeSignals,
  });

  await refreshMarketContext(); // warm the cache before serving traffic
  await app.listen({ host: config.apiHost, port: config.apiPort });
  // No secrets logged: host/port are the only runtime values here.
  console.log(`CryptoAI Pro Master Signal Engine listening on ${config.apiHost}:${config.apiPort}`);

  const bgTimer = setInterval(() => {
    void refreshMarketContext();
  }, MARKET_CONTEXT_TTL_MS);
  if (typeof bgTimer.unref === 'function') bgTimer.unref();

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`Received ${sig}, shutting down...`);
    clearInterval(bgTimer);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
