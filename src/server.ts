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
import type { BacktestTrade, EngineConfig, MarketContext, MasterSignal, SignalGrade, SymbolInput } from './types';

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
  tradeHistory?: BacktestTrade[];
  realizedPnl?: number;
  totalFees?: number;
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

/**
 * Grades the manual paper-order endpoint accepts. Mirrors the paper runner
 * and PaperTrader: A+/A always, plus NORMAL when the engine marks it ACTIVE
 * (score 80+, the user's configured paper-entry threshold).
 */
export function isManualOrderGradeOk(grade: SignalGrade): boolean {
  return grade === 'A+' || grade === 'A' || grade === 'NORMAL';
}

// ---------------------------------------------------------------------------
// Honest validation reporting.
//
// Contract: never present an uncalibrated number as a proven result. Every
// figure ships with its sample size, and the status says plainly whether
// anything can be concluded yet.
// ---------------------------------------------------------------------------

export interface HonestLiveStats {
  sampleTrades: number;
  winRatePct: number | null;
  /** Mean pnlQuote per closed trade — fee- and slippage-inclusive. */
  expectancyQuote: number | null;
  netPnlQuote: number;
  totalFeesQuote: number;
  maxDrawdownPct: number | null;
  status: 'NO_TRADES' | 'UNDER_TEST' | 'NO_EDGE' | 'EDGE_UNPROVEN';
  notes: string[];
}

/**
 * Aggregates closed paper trades into honest, fee-inclusive statistics.
 * pnlQuote is already net of fees/slippage/funding, so the expectancy shown
 * here is the real per-trade expectancy, not a gross figure.
 */
export function buildHonestLiveStats(
  trades: BacktestTrade[],
  startBalance: number,
): HonestLiveStats {
  const n = trades.length;
  if (n === 0) {
    return {
      sampleTrades: 0,
      winRatePct: null,
      expectancyQuote: null,
      netPnlQuote: 0,
      totalFeesQuote: 0,
      maxDrawdownPct: null,
      status: 'NO_TRADES',
      notes: ['No closed paper trades yet — nothing can be concluded.'],
    };
  }
  const wins = trades.filter((t) => t.pnlQuote > 0).length;
  const net = trades.reduce((s, t) => s + t.pnlQuote, 0);
  const fees = trades.reduce((s, t) => s + (Number.isFinite(t.fees) ? t.fees : 0), 0);
  // Max drawdown over the cumulative equity curve (chronological by exitTime).
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let eq = startBalance;
  let peak = startBalance;
  let maxDd = 0;
  for (const t of ordered) {
    eq += t.pnlQuote;
    if (eq > peak) peak = eq;
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - eq) / peak) * 100);
  }
  const expectancy = net / n;
  const notes: string[] = [];
  let status: HonestLiveStats['status'];
  if (n < 30) {
    status = 'UNDER_TEST';
    notes.push(`Sample too small (n=${n}<30) — no conclusions yet, still under test.`);
  } else if (expectancy <= 0) {
    status = 'NO_EDGE';
    notes.push('Expectancy is not positive: no edge demonstrated in live paper trading.');
  } else {
    status = 'EDGE_UNPROVEN';
    notes.push('Expectancy is positive but unproven — needs out-of-sample confirmation.');
  }
  notes.push('Expectancy is net of fees, slippage and funding (from pnlQuote).');
  return {
    sampleTrades: n,
    winRatePct: (wins / n) * 100,
    expectancyQuote: expectancy,
    netPnlQuote: net,
    totalFeesQuote: fees,
    maxDrawdownPct: maxDd,
    status,
    notes,
  };
}

/**
 * Verified backtest results (run 2026-10-22, static — these runs are done).
 * Universe: top-20 USDT pairs, ~5.5 months (May→Oct 2026), 1h/4h bars,
 * 1% risk/trade, 0.05% fee/side + 0.02% slippage. A losing backtest means the
 * idea has no edge — not a tuning problem.
 */
const BACKTEST_SUMMARY = {
  period: '2026-05 → 2026-10 (~5.5 months)',
  universe: 'top-20 USDT pairs (Binance)',
  costModel: '0.05% fee/side + 0.02% slippage, 1% risk/trade',
  runs: [
    { name: 'Engine (live-logic replay)', trades: 1, winRatePct: 0, profitFactor: 0, expectancyQuote: -102.81, maxDrawdownPct: 1.0, verdict: 'NO_EDGE' },
    { name: 'Scalp (dump-confirm LONG / pump-confirm SHORT)', trades: 516, winRatePct: 39.1, profitFactor: 0.95, expectancyQuote: -2.64, maxDrawdownPct: 42.4, verdict: 'NO_EDGE' },
    { name: 'RSI(2) mean reversion', trades: 2830, winRatePct: 56.3, profitFactor: 0.36, expectancyQuote: -3.52, maxDrawdownPct: 99.6, verdict: 'NO_EDGE' },
    { name: 'Donchian breakout (20/10)', trades: 1889, winRatePct: 27.8, profitFactor: 0.76, expectancyQuote: -5.19, maxDrawdownPct: 99.0, verdict: 'NO_EDGE' },
    { name: 'Bollinger (20,2) mean reversion', trades: 2519, winRatePct: 24.8, profitFactor: 0.34, expectancyQuote: -3.97, maxDrawdownPct: 100.0, verdict: 'NO_EDGE' },
  ],
  conclusion: '5 ideas tested, 0 edges found. NO_TRADE without evidence of edge is the system working correctly.',
};

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
  // Signal cache: fresh scans are slow on Render free tier (~15s per 5 symbols).
  // Primary source: signals-cache.json written by paper-run.js every cycle.
  // Fallback: in-memory cache from on-demand scan.
  let signalsCache: { ts: number; limit: number; result: unknown } | null = null;
  const SIGNALS_CACHE_MS = 5 * 60 * 1000;
  const SIGNALS_FILE = path.join(process.cwd(), 'signals-cache.json');

  app.get('/api/signals', async (req, reply) => {
    const q = req.query as { limit?: string; diag?: string };
    let limit = 20;
    if (q.limit !== undefined) {
      const n = Number(q.limit);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        reply.code(400);
        return { error: 'Invalid limit. Must be an integer between 1 and 50.' };
      }
      limit = n;
    }
    // ?diag=1 exposes full-scanner diagnostics (all analyzed symbols, not just
    // the top 50). Additive — the default response shape is unchanged.
    const wantDiag = q.diag === '1';
    // 1. Try signals-cache.json from paper runner (instant).
    try {
      const raw = fs.readFileSync(SIGNALS_FILE, 'utf8');
      const cached = JSON.parse(raw);
      if (cached && Array.isArray(cached.signals)) {
        const signals = cached.signals.slice(0, limit);
        return {
          count: signals.length, signals, cached: true,
          generatedAt: cached.generatedAt,
          scan_started_at: cached.scan_started_at,
          scan_completed_at: cached.scan_completed_at,
          ...(wantDiag && Array.isArray(cached.diagnostics)
            ? { diagnostics: cached.diagnostics, diag_count: cached.diagnostics.length }
            : {}),
        };
      }
    } catch { /* fall through to live scan */ }
    // 2. In-memory cache from previous on-demand scan.
    if (signalsCache && signalsCache.limit === limit && Date.now() - signalsCache.ts < SIGNALS_CACHE_MS) {
      return signalsCache.result;
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
      const result = { count: signals.length, signals };
      signalsCache = { ts: Date.now(), limit, result };
      return result;
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

  // ------------------------------------------------------- honest validation
  // Fee-inclusive live stats + verified backtest summary. Never presents an
  // uncalibrated score as a win probability; every figure carries its sample.
  app.get('/api/validation', async () => {
    const report = readPaperReport();
    const trades = report?.account?.tradeHistory ?? [];
    return {
      generatedAt: new Date().toISOString(),
      paperOnly: true,
      note: 'No real-money trading. Scores are not win probabilities — no calibration data exists.',
      live: buildHonestLiveStats(trades, deps.config.paperStartBalance),
      backtests: BACKTEST_SUMMARY,
    };
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
    // Manual orders must pass the same bar as the paper runner: A+/A, or
    // NORMAL when the engine marks it ACTIVE (score 80+, user threshold).
    const gradeOk = isManualOrderGradeOk(signal.signal_grade);
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
