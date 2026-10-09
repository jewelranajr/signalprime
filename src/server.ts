/**
 * CryptoAI Pro — Fastify HTTP API for the Master Signal Engine.
 *
 * Serves high-probability LONG/SHORT signals with strict NO_TRADE protection.
 * All data is public market data; this system holds no secrets and never
 * accepts, logs, or returns anything resembling an API key or credential.
 * Nothing here claims or implies guaranteed accuracy: confidence values are
 * model-derived estimates, not promises of outcome.
 */
import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { publicConfig } from './config';
import { buildSignal, noTradeSignal } from './engine';
import { correlationScore } from './filters';
import { detectRegime } from './regime';
import { computeIndicators } from './indicators';
import type { BinanceDataClient } from './exchange';
import type { CooldownTracker } from './filters';
import type { EngineConfig, MarketContext, MasterSignal, SymbolInput } from './types';

export interface ServerDeps {
  client: BinanceDataClient;
  config: EngineConfig;
  cooldowns: CooldownTracker;
  getMarketContext(): MarketContext;
  recordSignal(signal: MasterSignal): void;
  activeSignals(): MasterSignal[];
}

const API_VERSION = '1.0.0';

/** Uppercase alphanumerics, 2-20 chars, spot symbol ending in USDT. */
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

export function isValidSymbol(s: string): boolean {
  return typeof s === 'string' && SYMBOL_RE.test(s) && s.endsWith('USDT');
}

/** Never leak internals: surface only the message, never a stack trace. */
function safeMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Unknown error';
}

function lastFinite(values: number[] | undefined): number | null {
  if (!values || values.length === 0) return null;
  const v = values[values.length - 1];
  return Number.isFinite(v) ? v : null;
}

/**
 * Shared analysis pipeline for /api/signal/:symbol and /api/signals.
 * One bad symbol throws a caught exception => caller converts to safe NO_TRADE.
 *
 * @param record  true for the single-symbol route (records + cooldowns);
 *                false for the bulk scan (read-only, no recording).
 */
async function analyzeSymbol(
  deps: ServerDeps,
  symbol: string,
  opts: { record: boolean },
): Promise<MasterSignal> {
  const [candles, ticker] = await Promise.all([
    deps.client.getMultiTimeframe(symbol),
    deps.client.getTicker24h(symbol),
  ]);

  const input: SymbolInput = {
    symbol,
    candles,
    quoteVolume24h: ticker?.quoteVolume ?? 0,
    spreadPct: ticker?.spreadPct ?? 0,
  };
  const market = deps.getMarketContext();
  let signal = buildSignal(input, {
    config: deps.config,
    market,
    balance: deps.config.accountBalance,
  });

  const isDirectional = signal.direction === 'LONG' || signal.direction === 'SHORT';
  if (isDirectional) {
    const gate = deps.cooldowns.canEmit(symbol, signal.direction, signal.market_regime);
    if (!gate.ok) {
      // Convert to NO_TRADE; never record a blocked signal.
      signal = noTradeSignal(symbol, [gate.reason ?? 'Cooldown active'], {
        confidence: signal.confidence,
      });
    } else if (opts.record) {
      deps.recordSignal(signal);
      deps.cooldowns.record(signal);
    }
  }

  // Portfolio correlation overlay (directional signals only).
  if (signal.direction === 'LONG' || signal.direction === 'SHORT') {
    const now = Date.now();
    const actives = deps
      .activeSignals()
      .filter(
        (s) =>
          s.symbol !== symbol &&
          s.status === 'ACTIVE' &&
          Number.isFinite(Date.parse(s.expires_at)) &&
          Date.parse(s.expires_at) > now,
      );
    const sameDir = actives.filter((s) => s.direction === signal.direction).length;
    signal.correlation_score = correlationScore(sameDir, actives.length);
    if (signal.correlation_score > 80) {
      signal.warnings.push('High portfolio correlation');
    }
  }

  return signal;
}

/** LONG/SHORT first by confidence desc, then NO_TRADE by confidence desc. */
function compareSignals(a: MasterSignal, b: MasterSignal): number {
  const rank = (s: MasterSignal): number => (s.direction === 'NO_TRADE' ? 1 : 0);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return b.confidence - a.confidence;
}

/** Simple worker pool with a fixed concurrency cap. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const idx = next;
        next += 1;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const startedAt = Date.now();

export async function buildApp(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Global rate limiting from config (applies to every route).
  // IMPORTANT: the registration MUST be awaited before any route is defined:
  // @fastify/rate-limit attaches via an onRoute hook, so routes added before
  // the plugin finishes loading would silently bypass rate limiting.
  await app.register(rateLimit, {
    max: deps.config.rateLimitMax,
    timeWindow: deps.config.rateLimitWindowMs,
    // The builder's return value is THROWN by the plugin, so it must be a
    // real Error carrying statusCode 429 (a plain object would surface as 500).
    errorResponseBuilder: (_req, context) => {
      const err = new Error('Rate limit exceeded. Please try again later.') as Error & {
        statusCode: number;
        retryAfterSec: number;
      };
      err.statusCode = 429;
      err.retryAfterSec = Math.ceil(context.ttl / 1000);
      return err;
    },
  });

  // Never leak stack traces or internals in error responses.
  app.setErrorHandler((rawErr, _req, reply) => {
    const err = rawErr as { statusCode?: unknown; message?: unknown; retryAfterSec?: unknown };
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 500;
    if (status >= 500) {
      reply.code(500).send({ error: 'Internal error' });
    } else {
      const body: Record<string, unknown> = {
        error: typeof err.message === 'string' ? err.message : 'Request failed',
      };
      if (status === 429 && typeof err.retryAfterSec === 'number') {
        body.retryAfterSec = err.retryAfterSec;
      }
      reply.code(status).send(body);
    }
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'Not found' });
  });

  // ---------------------------------------------------------------- health
  app.get('/api/health', async () => ({
    ok: true,
    version: API_VERSION,
    time: new Date().toISOString(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  }));

  // ---------------------------------------------------------------- config
  app.get('/api/config', async () => publicConfig(deps.config));

  // ---------------------------------------------------------------- single signal
  app.get('/api/signal/:symbol', async (req, reply) => {
    const raw = (req.params as { symbol?: string }).symbol ?? '';
    if (!isValidSymbol(raw)) {
      reply.code(400);
      return {
        error: 'Invalid symbol. Expected format like BTCUSDT (2-20 uppercase A-Z0-9 chars, must end with USDT).',
      };
    }
    try {
      return await analyzeSymbol(deps, raw, { record: true });
    } catch (err) {
      // 200: one bad symbol never crashes the server.
      return noTradeSignal(raw, [`Internal error: ${safeMessage(err)}`]);
    }
  });

  // ---------------------------------------------------------------- bulk scan
  app.get('/api/signals', async (req, reply) => {
    const q = (req.query as { limit?: string }).limit;
    let limit = 20;
    if (q !== undefined) {
      const n = Number(q);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        reply.code(400);
        return { error: 'Invalid limit. Must be an integer between 1 and 50.' };
      }
      limit = n;
    }
    try {
      const symbols = await deps.client.getTopUsdtSymbols(limit);
      const valid = symbols.filter(isValidSymbol).slice(0, limit);
      const signals = await mapWithConcurrency(valid, 5, async (symbol) => {
        try {
          // Read-only scan: cooldowns gate the status but nothing is recorded.
          return await analyzeSymbol(deps, symbol, { record: false });
        } catch (err) {
          return noTradeSignal(symbol, [`Internal error: ${safeMessage(err)}`]);
        }
      });
      signals.sort(compareSignals);
      return { count: signals.length, signals };
    } catch (err) {
      return { count: 0, signals: [], error: `Internal error: ${safeMessage(err)}` };
    }
  });

  // ---------------------------------------------------------------- market overview
  app.get('/api/market/:symbol', async (req, reply) => {
    const raw = (req.params as { symbol?: string }).symbol ?? '';
    if (!isValidSymbol(raw)) {
      reply.code(400);
      return {
        error: 'Invalid symbol. Expected format like BTCUSDT (2-20 uppercase A-Z0-9 chars, must end with USDT).',
      };
    }
    try {
      const [candles, ticker] = await Promise.all([
        deps.client.getKlines(raw, '1h', 300),
        deps.client.getTicker24h(raw),
      ]);
      const ind = computeIndicators(candles);
      const det = detectRegime(candles, ind);
      const lastIdx = candles.length - 1;
      const close = lastIdx >= 0 ? candles[lastIdx].close : 0;
      const rsi = lastFinite(ind.rsi);
      const adx = lastFinite(ind.adx.adx);
      const atr = lastFinite(ind.atr);
      const atrPct = atr !== null && close > 0 ? (atr / close) * 100 : null;
      const ema20 = lastFinite(ind.ema20);
      const ema50 = lastFinite(ind.ema50);
      const emaTrend = ema20 !== null && ema50 !== null ? (ema20 > ema50 ? 'UP' : ema20 < ema50 ? 'DOWN' : 'FLAT') : null;
      return {
        symbol: raw,
        price: ticker?.lastPrice ?? close,
        change24hPct: ticker?.priceChangePct ?? 0,
        regime: det.regime,
        regimeNotes: det.notes,
        rsi,
        adx,
        atrPct,
        emaTrend,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      // 200: never crash on one symbol; report the failure as JSON.
      return { symbol: raw, error: `Internal error: ${safeMessage(err)}` };
    }
  });

  return app;
}
