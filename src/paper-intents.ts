/**
 * Paper-trading intent channel (VIRTUAL MONEY ONLY).
 *
 * The API server appends intents to paper-intents.json; the paper runner
 * executes pending intents once per cycle through the same PaperTrader with
 * the same strict engine filters. This module is import-safe (no side
 * effects) so the intent lifecycle is unit-testable.
 *
 * Manual-close fix (2026-10-22): a successful manual close fires the
 * optional onClose hook so the runner can (a) clear the symbol's pending
 * entry-confirmation and (b) start a manual-close cooldown — otherwise a
 * still-ACTIVE signal re-enters the identical setup seconds later.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PaperTrader } from './paper';
import { CooldownTracker } from './filters';
import type { BinanceDataClient } from './exchange';
import type { Direction, MasterSignal } from './types';

/** Intent queued via POST /api/paper/order|close (virtual money only). */
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

/**
 * Path of the intent file. Overridable via PAPER_INTENTS_PATH so tests can
 * use a temp file instead of the production one. Resolved at call time.
 */
export function intentsPath(): string {
  return process.env.PAPER_INTENTS_PATH ?? path.join(process.cwd(), 'paper-intents.json');
}

export function readPaperIntents(): PaperIntent[] {
  try {
    const raw = fs.readFileSync(intentsPath(), 'utf8');
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as PaperIntent[]) : [];
  } catch {
    return [];
  }
}

export function writePaperIntents(intents: PaperIntent[]): void {
  fs.writeFileSync(intentsPath(), JSON.stringify(intents, null, 2));
}

/**
 * Manual-close bookkeeping for the runner: drop the closed symbol's pending
 * entry-confirmation (a close invalidates the "confirmed" state) and start
 * the manual-close cooldown for the closed direction. Pure glue — kept here
 * so it is unit-testable without importing the runner script.
 */
export function applyManualClose(
  pendingConfirmations: Map<string, { direction: 'LONG' | 'SHORT'; cycle: number }>,
  cooldowns: CooldownTracker,
  symbol: string,
  direction: Direction,
  now?: number,
): void {
  pendingConfirmations.delete(symbol);
  cooldowns.recordManualClose(symbol, direction, now);
}

/**
 * Execute manual intents queued by the API through the same PaperTrader.
 * Open intents carry the engine signal snapshot; PaperTrader re-validates
 * grade/status/direction before filling. Runs once per cycle.
 *
 * An intent is marked 'done' only AFTER the ledger (paper-report.json) has
 * been saved through `persistLedger`. If the runner crashes before the save,
 * the intent stays 'pending' and is retried on the next cycle — so the app
 * can never show "done" for a close that never persisted (2026-10-12 fix).
 *
 * `onClose` fires exactly once per successfully executed close intent
 * (symbol, closed direction) — never for rejected/retried intents, so
 * repeated close intents are idempotent and never double-arm the cooldown.
 */
export async function processPaperIntents(
  client: BinanceDataClient,
  trader: PaperTrader,
  persistLedger: () => void,
  onClose?: (symbol: string, direction: Direction) => void,
): Promise<void> {
  let intents: PaperIntent[];
  try {
    const raw = fs.readFileSync(intentsPath(), 'utf8');
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
        if (!r.id) {
          it.status = 'rejected';
          it.note = r.reason ?? 'rejected';
        } else {
          try {
            persistLedger(); // save BEFORE marking done (same phantom-done guard as closes)
          } catch (err) {
            it.note = `ledger save failed; will retry next cycle (${err instanceof Error ? err.message : err})`;
            continue; // keep pending
          }
          it.status = 'done';
          it.note = `opened ${r.id}`;
        }
        console.log(`  intent ${it.id} (${it.type} ${it.symbol}): ${it.status} — ${it.note}`);
      } else if (it.type === 'close') {
        const pos = trader.account.positions.find((p) => p.symbol === it.symbol);
        if (!pos) {
          it.status = 'rejected';
          it.note = 'no open position';
        } else {
          const klines = await client.getKlines(it.symbol, '1m', 2);
          const price = klines.length > 0 ? klines[klines.length - 1].close : 0;
          if (!(price > 0)) {
            it.note = 'no market price; will retry next cycle';
            continue; // keep pending
          }
          trader.closePosition(pos.id, price, 'MANUAL');
          try {
            persistLedger(); // save BEFORE marking done — a crash before this
                             // leaves the intent pending so it retries next cycle
          } catch (err) {
            it.note = `ledger save failed; will retry next cycle (${err instanceof Error ? err.message : err})`;
            continue; // keep pending
          }
          it.status = 'done';
          it.note = `closed ${pos.id} @ ${price}`;
          onClose?.(it.symbol, pos.direction);
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
    fs.writeFileSync(intentsPath(), JSON.stringify(intents, null, 2));
  }
}
