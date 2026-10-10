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
import * as fs from 'node:fs';
import * as path from 'node:path';
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

/**
 * Paper-trading command channel (VIRTUAL MONEY ONLY).
 * The API server never trades by itself: POST /api/paper/order|close appends
 * an intent to paper-intents.json, and the paper runner (scripts/paper-run.js)
 * executes pending intents once per cycle through the same PaperTrader with
 * the same strict engine filters. Manual orders must still pass the engine:
 * ACTIVE status, requested direction, A+/A grade — otherwise rejected here.
 */
const PAPER_REPORT_PATH = path.join(process.cwd(), 'paper-report.json');
const PAPER_INTENTS_PATH = path.join(process.cwd(), 'paper-intents.json');

export interface PaperIntent {
  id: string;
  type: 'open' | 'close';
  symbol: string;
  direction?: 'LONG' | 'SHORT';
  signal?: MasterSignal;
  createdAt: string;
  status: 'pending' | 'done' | 'rejected';
  note?: string;
}

function readPaperIntents(): PaperIntent[] {
  try {
    const raw = fs.readFileSync(PAPER_INTENTS_PATH, 'utf8');
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as PaperIntent[]) : [];
  } catch {
    return [];
  }
}

function writePaperIntents(intents: PaperIntent[]): void {
  fs.writeFileSync(PAPER_INTENTS_PATH, JSON.stringify(intents, null, 2));
}

interface PaperReportAccount {
  balance?: number;
  equity?: number;
  openPositions?: Array<{ symbol: string }>;
}

function readPaperReport(): { account: PaperReportAccount; generatedAt?: string; cycle?: number } | null {
  try {
    const raw = fs.readFileSync(PAPER_REPORT_PATH, 'utf8');
    const report = JSON.parse(raw) as {
      account?: PaperReportAccount;
      generatedAt?: string;
      cycle?: number;
    };
    if (!report || typeof report !== 'object' || !report.account) return null;
    return { account: report.account, generatedAt: report.generatedAt, cycle: report.cycle };
  } catch {
    return null;
  }
}

function newIntentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

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

    // ---------------------------------------------------------------- paper status
  app.get('/api/paper/status', async () => {
    const report = readPaperReport();
    if (!report) {
      return { running: false, note: 'paper runner has not written a report yet' };
    }
    return { running: true, virtual: true, ...report };
  });

  // ---------------------------------------------------------------- paper intents
  app.get('/api/paper/intents', async () => {
    const intents = readPaperIntents();
    return { count: intents.length, intents: intents.slice(-20).reverse() };
  });

  // ---------------------------------------------------------------- paper order (manual, still engine-gated)
  app.post('/api/paper/order', async (req, reply) => {
    const body = (req.body ?? {}) as { symbol?: unknown; direction?: unknown };
    const symbol = typeof body.symbol === 'string' ? body.symbol.toUpperCase() : '';
    const direction = body.direction;
    if (!isValidSymbol(symbol)) {
      reply.code(400);
      return { error: 'Invalid symbol. Expected format like BTCUSDT.' };
    }
    if (direction !== 'LONG' && direction !== 'SHORT') {
      reply.code(400);
      return { error: 'direction must be LONG or SHORT' };
    }
    let signal: MasterSignal;
    try {
      signal = await analyzeSymbol(deps, symbol, { record: false });
    } catch {
      reply.code(500);
      return { error: 'Internal error' };
    }
    const gradeOk = signal.signal_grade === 'A+' || signal.signal_grade === 'A';
    if (signal.direction !== direction || signal.status !== 'ACTIVE' || !gradeOk) {
      reply.code(400);
      return {
        error:
          `rejected by strict engine: signal is ${signal.direction} ` +
          `(grade ${signal.signal_grade}, status ${signal.status}) — ` +
          'manual orders must pass the same filters',
        engine: {
          direction: signal.direction,
          grade: signal.signal_grade,
          status: signal.status,
          confidence: signal.confidence,
        },
      };
    }
    const report = readPaperReport();
    const alreadyOpen = report?.account.openPositions?.some((p) => p.symbol === symbol);
    if (alreadyOpen) {
      reply.code(400);
      return { error: `a paper position is already open for ${symbol}` };
    }
    const intents = readPaperIntents();
    if (intents.some((i) => i.status === 'pending' && i.symbol === symbol)) {
      reply.code(400);
      return { error: `an intent for ${symbol} is already pending` };
    }
    const intent: PaperIntent = {
      id: newIntentId(),
      type: 'open',
      symbol,
      direction,
      signal,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    intents.push(intent);
    try {
      writePaperIntents(intents);
    } catch {
      reply.code(500);
      return { error: 'Internal error' };
    }
    return {
      ok: true,
      intentId: intent.id,
      queued: 'the paper runner executes this on its next cycle',
      virtual: true,
      note: 'VIRTUAL MONEY ONLY — no real orders are placed',
    };
  });

  // ---------------------------------------------------------------- paper close
  app.post('/api/paper/close', async (req, reply) => {
    const body = (req.body ?? {}) as { symbol?: unknown };
    const symbol = typeof body.symbol === 'string' ? body.symbol.toUpperCase() : '';
    if (!isValidSymbol(symbol)) {
      reply.code(400);
      return { error: 'Invalid symbol. Expected format like BTCUSDT.' };
    }
    const report = readPaperReport();
    const open = report?.account.openPositions?.some((p) => p.symbol === symbol);
    if (!open) {
      reply.code(400);
      return { error: `no open paper position for ${symbol}` };
    }
    const intents = readPaperIntents();
    if (intents.some((i) => i.status === 'pending' && i.type === 'close' && i.symbol === symbol)) {
      reply.code(400);
      return { error: `a close intent for ${symbol} is already pending` };
    }
    const intent: PaperIntent = {
      id: newIntentId(),
      type: 'close',
      symbol,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    intents.push(intent);
    try {
      writePaperIntents(intents);
    } catch {
      reply.code(500);
      return { error: 'Internal error' };
    }
    return { ok: true, intentId: intent.id, virtual: true };
  });

  return app;
}
