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
 *   3. Opens virtual positions from ACTIVE A+/A signals only
 *      (PaperTrader also enforces this + one position per symbol).
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
import type { MasterSignal } from '../types';

const REPORT_PATH = path.join(process.cwd(), 'paper-report.json');
const INTENTS_PATH = path.join(process.cwd(), 'paper-intents.json');

/** Intent queued via POST /api/paper/order|close (virtual money only). */
interface PaperIntent {
  id: string;
  type: 'open' | 'close';
  symbol: string;
  direction?: 'LONG' | 'SHORT';
  signal?: MasterSignal;
  createdAt: string;
  status: 'pending' | 'done' | 'rejected';
  note?: string;
}

/**
 * Execute manual intents queued by the API through the same PaperTrader.
 * Open intents carry the engine signal snapshot; PaperTrader re-validates
 * grade/status/direction before filling. Runs once per cycle.
 */
async function processPaperIntents(
  client: BinanceDataClient,
  trader: PaperTrader,
): Promise<void> {
  let intents: PaperIntent[];
  try {
    const raw = fs.readFileSync(INTENTS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    intents = parsed as PaperIntent[];
  } catch {
    return; // no intent file yet
  }
  let changed = false;
  for (const it of intents) {
    if (!it || it.status !== 'pending') continue;
    try {
      if (it.type === 'open' && it.signal) {
        const r = trader.openFromSignal(it.signal);
        it.status = r.id ? 'done' : 'rejected';
        it.note = r.id ? `opened ${r.id}` : (r.reason ?? 'rejected');
        console.log(`  intent ${it.id} (${it.type} ${it.symbol}): ${it.status} — ${it.note}`);
      } else if (it.type === 'close') {
        const pos = trader.account.positions.find((p) => p.symbol === it.symbol);
        if (!pos) {
          it.status = 'rejected';
          it.note = 'no open position';
        } else {
          const ticker = await client.getTicker24h(it.symbol);
          const price = ticker?.lastPrice ?? 0;
          if (!(price > 0)) {
            it.note = 'no market price; will retry next cycle';
            continue; // keep pending
          }
          trader.closePosition(pos.id, price, 'MANUAL');
          it.status = 'done';
          it.note = `closed ${pos.id} @ ${price}`;
        }
        console.log(`  intent ${it.id} (${it.type} ${it.symbol}): ${it.status} — ${it.note ?? ''}`);
      } else {
        it.status = 'rejected';
        it.note = 'unknown intent type';
      }
    } catch (err) {
      it.status = 'rejected';
      it.note = err instanceof Error ? err.message : 'error';
    }
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(INTENTS_PATH, JSON.stringify(intents, null, 2));
  }
}

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

function printReport(trader: PaperTrader, cycle: number): void {
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
    printReport(trader, cycle);
  };
  let cycle = 0;
  let rotationOffset = 0;
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!stop && cycle < cycles) {
    cycle++;

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
      // 1. Market context (BTC/ETH 1h).
      const [btc, eth, btcT, ethT] = await Promise.all([
        client.getKlines('BTCUSDT', '1h', 250),
        client.getKlines('ETHUSDT', '1h', 250),
        client.getTicker24h('BTCUSDT'),
        client.getTicker24h('ETHUSDT'),
      ]);
      const market = buildMarketContext(btc, eth, btcT?.priceChangePct, ethT?.priceChangePct);
      if (market.btcViolentDump) {
        console.log('BTC violent dump — skipping new entries this cycle.');
      }

      // 1b. Manual intents from the mobile/API client (virtual money only).
      await processPaperIntents(client, trader);

      // 2+3. Scan symbols, open A+/A signals.
      for (const symbol of symbols) {
        if (stop) break;
        let signal: MasterSignal;
        try {
          const [candles, ticker] = await Promise.all([
            client.getMultiTimeframe(symbol),
            client.getTicker24h(symbol),
          ]);
          signal = buildSignal(
            {
              symbol,
              candles,
              quoteVolume24h: ticker?.quoteVolume ?? 0,
              spreadPct: ticker?.spreadPct ?? 0,
            },
            { config, market, balance: config.accountBalance, now: Date.now() },
          );
        } catch (err) {
          console.log(`${symbol}: analysis failed (${err instanceof Error ? err.message : err})`);
          continue;
        }
        console.log(
          `${symbol}: ${signal.direction} grade=${signal.signal_grade} ` +
            `long=${fmt(signal.long_score, 1)} short=${fmt(signal.short_score, 1)} ` +
            `conf=${signal.confidence} regime=${signal.market_regime}`,
        );
        if (signal.direction === 'NO_TRADE' || signal.status !== 'ACTIVE') continue;
        if (signal.signal_grade !== 'A+' && signal.signal_grade !== 'A') continue;
        const gate = cooldowns.canEmit(symbol, signal.direction, signal.market_regime);
        if (!gate.ok) {
          console.log(`  cooldown: ${gate.reason}`);
          continue;
        }
        const opened = trader.openFromSignal(signal);
        if (opened.id) {
          cooldowns.record(signal);
          console.log(`  OPENED virtual ${signal.direction} ${symbol} (id=${opened.id})`);
        } else {
          console.log(`  not opened: ${opened.reason}`);
        }
      }

      // 4. Settle open positions on fresh closed 15m candles.
      const openSymbols = [...new Set(trader.account.positions.map((p) => p.symbol))];
      for (const symbol of openSymbols) {
        const klines = await client.getKlines(symbol, '15m', 96);
        for (const c of klines) trader.onCandle(symbol, c);
      }
      trader.accrueFunding(Date.now());

      // 5. Report.
      printReport(trader, cycle);
    } catch (err) {
      console.error(`cycle #${cycle} error: ${err instanceof Error ? err.message : err}`);
    }
    if (cycle < cycles && !stop && everyMin > 0) {
      await sleep(everyMin * 60_000);
    }
  }
  printReport(trader, cycle);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
