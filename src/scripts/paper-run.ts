/**
 * Paper-trading runner: live market data, virtual money.
 * Usage: node dist/scripts/paper-run.js [SYMBOL ...] [--cycles N] [--every-min M]
 *        [--top N] [--batch M] [--symbols-file PATH]
 *
 * Each cycle:
 *   1. Refreshes the BTC/ETH market context.
 *   2. Scans each symbol through the Master Signal Engine (strict config).
 *      With --top N, scans the top-N USDT pairs by 24h volume in rotating
 *      batches of --batch (default 100): e.g. --top 500 --batch 100 covers
 *      all 500 pairs every 5 cycles while staying inside Binance rate limits.
 *      With --symbols-file PATH, loads a fixed symbol list once from a JSON
 *      file ({symbols:[...]} or [...]) and rotates through it — no re-fetch.
 *   3. Opens virtual positions from ACTIVE A+/A/NORMAL signals
 *      (PaperTrader re-validates grade + one position per symbol).
 *      NORMAL opens only when the engine marked it ACTIVE (score 80+);
 *      grades are recorded per trade for separate Normal vs Good tracking.
 *   4. Settles open positions against fresh closed 15m candles
 *      (conservative stop-before-TP ordering, fees, slippage, funding).
 *   5. Prints an account summary and writes paper-report.json.
 *
 * This codebase places NO live orders — accounting only.
 * Stop with Ctrl+C; a final report is printed on exit.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config';
import { BinanceDataClient } from '../exchange';
import { buildSignal } from '../engine';
import { PaperTrader } from '../paper';
import { CooldownTracker, buildMarketContext } from '../filters';
import { applyManualClose, processPaperIntents } from '../paper-intents';
import type { MasterSignal } from '../types';

const REPORT_PATH = path.join(process.cwd(), 'paper-report.json');
const SIGNALS_CACHE_PATH = path.join(process.cwd(), 'signals-cache.json');

function parseArgs(argv: string[]): {
  symbols: string[];
  cycles: number;
  everyMin: number;
  top: number;
  batch: number;
  symbolsFile: string | null;
} {
  const symbols: string[] = [];
  let cycles = Number.POSITIVE_INFINITY;
  let everyMin = 15;
  let top = 0;
  let batch = 100;
  let symbolsFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cycles' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) cycles = Math.floor(n);
    } else if (a === '--every-min' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) everyMin = n;
    } else if (a === '--top' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) top = Math.floor(n);
    } else if (a === '--batch' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) batch = Math.floor(n);
    } else if (a === '--symbols-file' && i + 1 < argv.length) {
      symbolsFile = argv[++i];
    } else if (!a.startsWith('--')) {
      symbols.push(a.toUpperCase());
    }
  }
  if (symbols.length === 0 && top <= 0 && !symbolsFile)
    symbols.push('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT');
  return { symbols, cycles, everyMin, top, batch, symbolsFile };
}

/** Load a fixed symbol universe from JSON: {symbols:[...]} or plain [...]. */
function loadSymbolsFile(p: string): string[] {
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw) as unknown;
  const arr = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { symbols?: unknown }).symbols)
      ? (data as { symbols: unknown }).symbols
      : [];
  return (arr as unknown[])
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => s.toUpperCase());
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printReport(trader: PaperTrader, cycle: number, cooldowns?: CooldownTracker): void {
  const a = trader.account;
  const closed = a.tradeHistory;
  const wins = closed.filter((t) => t.pnlQuote > 0).length;
  console.log(`\n--- paper cycle #${cycle} @ ${new Date().toISOString()} ---`);
  console.log(
    `balance=${fmt(a.balance)} equity=${fmt(a.equity)} realizedPnL=${fmt(a.realizedPnl)} ` +
      `fees=${fmt(a.totalFees)} funding=${fmt(a.totalFunding)}`,
  );
  console.log(
    `open=${a.positions.length} closed=${closed.length} ` +
      `winRate=${closed.length > 0 ? fmt((wins / closed.length) * 100, 1) : 'n/a'}%`,
  );
  for (const p of a.positions) {
    console.log(
      `  OPEN ${p.direction} ${p.symbol} entry=${fmt(p.entry, 4)} qty=${fmt(p.quantity, 4)} ` +
        `SL=${fmt(p.stopLoss, 4)} TPs=${p.takeProfits.map((t) => fmt(t, 2)).join('/')}`,
    );
  }
  for (const t of closed.slice(-5)) {
    console.log(
      `  CLOSED ${t.direction} ${t.symbol} pnl=${fmt(t.pnlQuote)} (${fmt(t.pnlPct, 2)}%) ` +
        `exit=${t.exitReason} grade=${t.grade}`,
    );
  }
  const report = {
    generatedAt: new Date().toISOString(),
    cycle,
    account: {
      balance: a.balance,
      equity: a.equity,
      realizedPnl: a.realizedPnl,
      totalFees: a.totalFees,
      totalFunding: a.totalFunding,
      openPositions: a.positions,
      tradeHistory: a.tradeHistory,
    },
    cooldowns: cooldowns?.serialize() ?? [],
    slCooldowns: cooldowns?.serializeSlCooldowns() ?? [],
    manualCooldowns: cooldowns?.serializeManualCooldowns() ?? [],
    note: 'Virtual money. Past simulation does not predict future results.',
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`report -> ${REPORT_PATH}`);
}

async function main(): Promise<void> {
  const { symbols: fixedSymbols, cycles, everyMin, top, batch, symbolsFile } = parseArgs(
    process.argv.slice(2),
  );
  const config = loadConfig();
  if (!config.paperEnabled) {
    console.error('Paper trading is disabled (PAPER_ENABLED=false). Enable it to run.');
    process.exit(1);
  }
  const client = new BinanceDataClient(config);
  const cooldowns = new CooldownTracker(config);
  const trader = new PaperTrader(config);

  // Restore previous session state so Render restarts don't wipe the ledger.
  const hydrated = trader.hydrateFromReport(REPORT_PATH);
  if (!hydrated) {
    console.log('no previous paper state found; starting fresh.');
  } else {
    // Restore cooldowns to prevent duplicate entries after restart
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const raw = fs.readFileSync(REPORT_PATH, 'utf8');
      const data = JSON.parse(raw) as { cooldowns?: Array<{ symbol: string; time: number; direction: 'LONG' | 'SHORT' | 'NO_TRADE'; regime: import('../types').MarketRegime }>; slCooldowns?: Array<{ symbol: string; direction: 'LONG' | 'SHORT'; time: number }>; manualCooldowns?: Array<{ symbol: string; direction: 'LONG' | 'SHORT'; time: number }> };
      if (data.cooldowns) {
        cooldowns.deserialize(data.cooldowns);
        console.log(`restored ${data.cooldowns.length} cooldown records`);
      }
      if (data.slCooldowns) {
        cooldowns.deserializeSlCooldowns(data.slCooldowns);
        console.log(`restored ${data.slCooldowns.length} post-SL cooldown records`);
      }
      if (data.manualCooldowns) {
        cooldowns.deserializeManualCooldowns(data.manualCooldowns);
        console.log(`restored ${data.manualCooldowns.length} manual-close cooldown records`);
      }
    } catch { /* non-fatal */ }
  }

  // Fixed universe from file: loaded once, never re-fetched.
  let fileUniverse: string[] | null = null;
  if (symbolsFile) {
    try {
      fileUniverse = loadSymbolsFile(symbolsFile);
      console.log(`loaded ${fileUniverse.length} symbols from ${symbolsFile} (fixed list)`);
    } catch (err) {
      console.error(`cannot load symbols file ${symbolsFile}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    if (fileUniverse.length === 0) {
      console.error(`symbols file ${symbolsFile} contains no symbols.`);
      process.exit(1);
    }
  }

  const scanDesc =
    fileUniverse !== null
      ? `${fileUniverse.length} fixed symbols from file in rotating batches of ${batch}`
      : top > 0
        ? `top-${top} USDT pairs by volume in rotating batches of ${batch}`
        : fixedSymbols.join(', ');
  console.log(
    `Paper trading ${scanDesc} — start balance ${config.paperStartBalance}, ` +
      `risk ${config.riskPercent}%/trade, fee ${config.paperFeePct}%, ` +
      `slippage ${config.paperSlippagePct}%, funding ${config.paperFundingPct8h}%/8h. ` +
      'VIRTUAL MONEY ONLY.',
  );

  let stop = false;
  const shutdown = () => {
    if (stop) return;
    stop = true;
    console.log('\nShutting down — final report:');
    printReport(trader, cycle, cooldowns);
  };
  let cycle = 0;
  let rotationOffset = 0;
  // Entry confirmation: symbol -> first-seen ACTIVE signal awaiting one
  // confirming cycle. A signal must survive a second consecutive cycle
  // with the same direction before the runner opens it — one fresh
  // 15m candle must confirm the setup instead of entering on first sight.
  // In-memory only: a restart simply requires the signal to be seen twice
  // again (fail-safe, no stale pending state).
  const pendingConfirmations = new Map<string, { direction: 'LONG' | 'SHORT'; cycle: number }>();
  // P2 diagnostics: symbols whose signal confirmed and opened this cycle
  // (pendingConfirmations entry is deleted on open, so track separately).
  const confirmedThisCycle = new Set<string>();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!stop && cycle < cycles) {
    cycle++;
    confirmedThisCycle.clear(); // P2 diagnostics: per-cycle confirmed opens

    // Resolve this cycle's symbol list (rotation for --top / --symbols-file).
    let symbols = fixedSymbols;
    const rotatingUniverse: string[] | null =
      fileUniverse !== null ? fileUniverse : top > 0 ? await client.getTopUsdtSymbols(top) : null;
    if (rotatingUniverse !== null) {
      const all = rotatingUniverse;
      if (all.length === 0) {
        console.log('symbol universe empty; skipping scan this cycle.');
        if (cycle < cycles && !stop && everyMin > 0) await sleep(everyMin * 60_000);
        continue;
      }
      const n = Math.min(batch, all.length);
      symbols = [];
      for (let i = 0; i < n; i++) symbols.push(all[(rotationOffset + i) % all.length]);
      rotationOffset = (rotationOffset + n) % all.length;
      console.log(
        `scanning batch: ${symbols.length} symbols ` +
          `(rotation ${rotationOffset}/${all.length})`,
      );
    }
    try {
      // 1. Market context (BTC/ETH 1h) + bulk ticker map (1 API call for all
      //    tickers instead of one call per symbol — ~30% faster per cycle).
      const [btc, eth, tickerMap] = await Promise.all([
        client.getKlines('BTCUSDT', '1h', 250),
        client.getKlines('ETHUSDT', '1h', 250),
        client.getAllTickersMap(),
      ]);
      const btcT = tickerMap.get('BTCUSDT');
      const ethT = tickerMap.get('ETHUSDT');
      const market = buildMarketContext(btc, eth, btcT?.priceChangePct, ethT?.priceChangePct);
      if (market.btcViolentDump) {
        console.log('BTC violent dump — skipping new entries this cycle.');
      }

      // 1b. Manual intents from the mobile/API client (virtual money only).
      // persistLedger saves paper-report.json immediately so an intent is only
      // marked 'done' after the ledger actually reflects it (2026-10-12 fix).
      await processPaperIntents(client, trader, () => printReport(trader, cycle, cooldowns),
        (symbol, direction) => applyManualClose(pendingConfirmations, cooldowns, symbol, direction));

      // 2+3. Scan symbols, open A+/A/NORMAL signals.
      // Two-phase scan:
      //   Phase 1 — concurrent analysis (fetch + buildSignal). Pure per-symbol
      //   work, no shared mutable state; bounded by MAX_CONCURRENCY (default 8).
      //   The exchange client's own semaphore + 429 hard-stop + backoff keep
      //   this rate-limit safe.
      //   Phase 2 — serial gate pipeline (pendingConfirmations / cooldowns /
      //   trader). Unchanged behavior: identical order and semantics to the
      //   previous serial loop.
      // NORMAL only reaches here with ACTIVE status (engine gates <80 itself).
      const allSignals: MasterSignal[] = [];
      const scanStartedAt = new Date().toISOString();
      const scanT0 = Date.now();
      const poolSize = Math.max(1, Math.min(10, Math.floor(Number(config.maxConcurrency) || 5)));
      interface Analyzed {
        symbol: string;
        signal: MasterSignal | null;
        ticker: { quoteVolume: number; priceChangePct: number; lastPrice: number } | undefined;
        /** P2 diagnostics: last closed primary-tf candle time (data freshness). */
        candleTime: number | null;
      }
      const analyzed: Analyzed[] = [];
      for (let k = 0; k < symbols.length && !stop; k += poolSize) {
        const chunk = symbols.slice(k, k + poolSize);
        const results = await Promise.all(
          chunk.map(async (symbol): Promise<Analyzed> => {
            try {
              const candles = await client.getMultiTimeframe(symbol);
              const t = tickerMap.get(symbol);
              const signal = buildSignal(
                {
                  symbol,
                  candles,
                  quoteVolume24h: t?.quoteVolume ?? 0,
                  spreadPct: 0, // spread filter skipped in bulk mode; volume check still applies
                },
                // R4 (P0 data integrity): size positions off live paper equity, not the
                // static config.accountBalance. account.equity is a live getter
                // (balance + unrealized at last 15m closes); risk compounds on wins
                // and shrinks on losses instead of staying pinned at $100/trade.
                { config, market, balance: trader.account.equity, now: Date.now() },
              );
              // P2 diagnostics: last closed candle time (4h primary, 1h fallback).
              const tfCandles =
                candles['4h'] && candles['4h'].length > 0 ? candles['4h'] : candles['1h'] ?? [];
              const lastCandle = tfCandles.length > 0 ? tfCandles[tfCandles.length - 1] : null;
              const candleTime =
                lastCandle && Number.isFinite(lastCandle.closeTime) ? lastCandle.closeTime : null;
              return { symbol, signal, ticker: t, candleTime };
            } catch (err) {
              console.log(`${symbol}: analysis failed (${err instanceof Error ? err.message : err})`);
              return { symbol, signal: null, ticker: undefined, candleTime: null };
            }
          }),
        );
        analyzed.push(...results);
      }
      // Phase 2 — serial gates.
      const gateBucket = (reason: string): string => {
        if (reason.includes('below minimum score')) return 'score<minScore';
        if (reason.includes('NORMAL tier below paper entry threshold')) return 'score<80(NORMAL-paper)';
        if (reason.includes('Direction gap')) return 'direction-gap';
        if (reason.includes('MTF does not confirm')) return 'MTF-conflict';
        if (reason.includes('Confidence below')) return 'confidence';
        if (reason.includes('RR below minimum')) return 'RR';
        if (reason.includes('Liquidity')) return 'liquidity';
        return 'other';
      };
      const gateCounts = new Map<string, number>();
      let fetchFailed = 0;
      let nActive = 0;
      let nWaiting = 0;
      let nWatch = 0; // Phase 2: display-only WATCH notices (never executable)
      for (const a of analyzed) {
        if (!a.signal) { fetchFailed++; continue; }
        const symbol = a.symbol;
        const signal: MasterSignal = a.signal;
        const ticker = a.ticker;
        allSignals.push(signal);
        console.log(
          `${symbol}: ${signal.direction} grade=${signal.signal_grade} ` +
            `long=${fmt(signal.long_score, 1)} short=${fmt(signal.short_score, 1)} ` +
            `conf=${signal.confidence} regime=${signal.market_regime}`,
        );
        if (signal.direction === 'NO_TRADE' || signal.status !== 'ACTIVE') {
          // Signal lost/flipped: a pending confirmation no longer applies.
          if (pendingConfirmations.has(symbol)) pendingConfirmations.delete(symbol);
          if (signal.direction === 'NO_TRADE') {
            const b = gateBucket(signal.reasons[0] ?? 'unknown');
            gateCounts.set(b, (gateCounts.get(b) ?? 0) + 1);
            if (signal.watch) nWatch++;
          } else {
            nWaiting++;
            console.log(`  waiting: ${signal.reasons[0] ?? 'n/a'}`);
          }
          continue;
        }
        nActive++;
        // A+/A always; NORMAL only when engine emitted it ACTIVE (score 80+,
        // user threshold — the 65-80 NORMAL band stays display-only NO_TRADE).
        if (signal.signal_grade !== 'A+' && signal.signal_grade !== 'A' && signal.signal_grade !== 'NORMAL') continue;
        // Volume gate: skip thin markets for paper entry (unreliable signals).
        const quoteVol = ticker?.quoteVolume ?? 0;
        if (!(quoteVol >= config.paperMinQuoteVolume24h)) {
          console.log(`  volume: ${symbol} 24h quote volume ${fmt(quoteVol, 0)} below paper minimum ${config.paperMinQuoteVolume24h} — skipped`);
          continue;
        }
        // Choppy-regime gate: NORMAL (lower-conviction) signals are skipped
        // in SIDEWAYS / LOW_VOLATILITY regimes — the worst chop. A+/A
        // signals passed strict gates and are still allowed (mean-reversion
        // setups can work in ranging markets when conviction is high).
        if (
          config.paperBlockNormalInChop &&
          signal.signal_grade === 'NORMAL' &&
          (signal.market_regime === 'SIDEWAYS' || signal.market_regime === 'LOW_VOLATILITY')
        ) {
          console.log(`  choppy regime: ${signal.market_regime} — NORMAL signal skipped`);
          continue;
        }
        const gate = cooldowns.canEmit(symbol, signal.direction, signal.market_regime);
        if (!gate.ok) {
          console.log(`  cooldown: ${gate.reason}`);
          continue;
        }
        // Entry confirmation: first sighting only records the signal; the
        // open happens on the next cycle if the same direction is still
        // ACTIVE (one confirming candle). A flipped/lost signal clears it.
        const pending = pendingConfirmations.get(symbol);
        if (!pending || pending.direction !== signal.direction) {
          pendingConfirmations.set(symbol, { direction: signal.direction, cycle });
          console.log(`  awaiting confirmation: ${signal.direction} ${symbol} first seen cycle #${cycle}`);
          continue;
        }
        if (pending.cycle >= cycle) {
          // Same-cycle re-sight (should not happen); wait for next cycle.
          continue;
        }
        pendingConfirmations.delete(symbol);
        const opened = trader.openFromSignal(signal);
        if (opened.id) {
          cooldowns.record(signal);
          confirmedThisCycle.add(symbol); // P2 diagnostics: confirmed+opened this cycle
          console.log(`  OPENED virtual ${signal.direction} ${symbol} (id=${opened.id})`);
        } else {
          console.log(`  not opened: ${opened.reason}`);
        }
      }

      // Scan observability: duration, counts, top rejection gates.
      const scanMs = Date.now() - scanT0;
      console.log(
        `scan done: ${symbols.length} coins, ${fetchFailed} failed, ` +
          `${nActive} ACTIVE, ${nWaiting} WAITING, ${nWatch} WATCH in ${(scanMs / 1000).toFixed(1)}s (pool=${poolSize})`,
      );
      if (gateCounts.size > 0) {
        const top = [...gateCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log('  top NO_TRADE gates: ' + top.map(([g, n]) => `${g}=${n}`).join(', '));
      }

      // Save signals cache for /api/signals (instant API response).
      // Sort by best score descending, keep top 50. Atomic write (tmp + rename)
      // so readers never see a partial file. If the scan analyzed nothing
      // (e.g. exchange outage), retain the previous cache instead of blanking it.
      allSignals.sort((a, b) => Math.max(b.long_score, b.short_score) - Math.max(a.long_score, a.short_score));
      const scanCompletedAt = new Date().toISOString();
      try {
        if (allSignals.length === 0 && fs.existsSync(SIGNALS_CACHE_PATH)) {
          console.log('scan produced no analyzable symbols; retaining previous signals cache');
        } else {
          // Full-scanner diagnostics: lightweight per-symbol rows for ALL analyzed
      // symbols (not just the top 50), so /api/signals?diag=1 can expose what
      // the top-50 cut hides. Additive — the existing signals array is untouched.
      const diagnostics = analyzed.map((a) => {
        const s = a.signal;
        if (!s) return { symbol: a.symbol, ok: false, error: 'fetch/analysis failed' };
        // P2 diagnostics: confirmation state for this cycle.
        const confirmation = confirmedThisCycle.has(a.symbol)
          ? 'confirmed-opened'
          : pendingConfirmations.has(a.symbol)
            ? 'awaiting-confirmation'
            : null;
        return {
          symbol: a.symbol,
          ok: true,
          long_score: Math.round(s.long_score * 10) / 10,
          short_score: Math.round(s.short_score * 10) / 10,
          direction: s.direction,
          status: s.status,
          grade: s.signal_grade,
          regime: s.market_regime,
          watch: !!s.watch,
          gate: s.direction === 'NO_TRADE' ? gateBucket(s.reasons[0] ?? 'unknown') : 'passed',
          // P2: rejection-stage detail (additive; default /api/signals shape unchanged).
          rejection: s.direction === 'NO_TRADE' ? (s.reasons[0] ?? 'unknown') : null,
          confidence: s.confidence,
          penalty_groups: s.penalty_groups ?? [],
          confirmation,
          candle_time: a.candleTime,
        };
      });
          const tmpPath = SIGNALS_CACHE_PATH + '.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify({
            generatedAt: scanCompletedAt,
            scan_started_at: scanStartedAt,
            scan_completed_at: scanCompletedAt,
            count: allSignals.length,
            signals: allSignals.slice(0, 50),
            diagnostics,
          }));
          fs.renameSync(tmpPath, SIGNALS_CACHE_PATH);
        }
      } catch { /* non-fatal */ }

      // 4. Settle open positions on fresh closed 15m candles.
      const historyBefore = trader.account.tradeHistory.length;
      const openSymbols = [...new Set(trader.account.positions.map((p) => p.symbol))];
      for (const symbol of openSymbols) {
        const klines = await client.getKlines(symbol, '15m', 96);
        for (const c of klines) trader.onCandle(symbol, c);
      }
      trader.accrueFunding(Date.now());
      // Post-SL cooldown: any trade that closed at SL this cycle blocks
      // re-entry of the same symbol+direction for 24h (breaks re-entry
      // loops — one failed setup must not reopen minutes later).
      const newTrades = trader.account.tradeHistory.slice(historyBefore);
      for (const t of newTrades) {
        if (t.exitReason === 'SL') {
          cooldowns.recordStopLoss(t.symbol, t.direction, t.exitTime);
          console.log(`  post-SL cooldown: ${t.direction} ${t.symbol} blocked 24h`);
        }
      }

      // 5. Report.
      printReport(trader, cycle, cooldowns);
    } catch (err) {
      console.error(`cycle #${cycle} error: ${err instanceof Error ? err.message : err}`);
    }
    if (cycle < cycles && !stop && everyMin > 0) {
      await sleep(everyMin * 60_000);
    }
  }
  printReport(trader, cycle, cooldowns);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
