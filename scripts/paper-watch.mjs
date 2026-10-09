#!/usr/bin/env node
/**
 * paper-watch.mjs — lightweight watchdog for the background paper-trading session.
 *
 * Dependency-free. Reads paper-report.json, compares against local state, and
 * prints a JSON verdict to stdout (exit 0 always, unless the script itself crashes).
 *
 * Checks:
 *  1. Is the paper-run.js node process alive? If it died unexpectedly, restart it
 *     with the last-known launch args (max 3 restarts per UTC day, then escalate).
 *  2. Is paper-report.json fresh (<= 30 min old)?
 *  3. New events since last check: position opened, position closed.
 *
 * First run only writes a baseline — no events, no restarts.
 *
 * IMPORTANT: enable (schedule) this only AFTER the intended paper session
 * (e.g. the --top 500 rotation) has completed its first cycle, so the
 * baseline and last-known launch args match the intended session. If the
 * session is ever restarted manually with different args, delete
 * paper-watch-state.json to force a fresh baseline.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(here, '..');
const REPORT = path.join(PROJ, 'paper-report.json');
const STATE = path.join(here, 'paper-watch-state.json');
const LOG = path.join(PROJ, 'paper-trading.log');
const FRESH_MIN = 30;
const MAX_RESTARTS_PER_DAY = 3;

const verdict = {
  ok: true,
  baseline: false,
  sessionAlive: false,
  reportFresh: false,
  reportAgeMin: null,
  restarted: false,
  events: [],
  deferred: 0,
};

// User's quiet hours: hold non-urgent event notifications outside 09:00–21:30
// Asia/Dhaka; the next in-window run delivers them as a catch-up batch.
function dhakaHHMM(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}
function inDeliveryWindow(hhmm = dhakaHHMM()) {
  return hhmm >= '09:00' && hhmm < '21:30';
}

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

function findPaperProcs() {
  let out = '';
  try {
    out = execSync('ps -eo pid,args', { encoding: 'utf8', timeout: 10000 });
  } catch {
    return [];
  }
  const procs = [];
  for (const line of out.split('\n')) {
    if (!line.includes('paper-run.js') || line.includes('paper-watch')) continue;
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), args: m[2] });
  }
  // Prefer the real node process over the bash wrapper.
  procs.sort((a, b) => (a.args.startsWith('node ') ? -1 : 1) - (b.args.startsWith('node ') ? -1 : 1));
  return procs;
}

function launchArgsFrom(procArgs) {
  const i = procArgs.indexOf('paper-run.js');
  if (i < 0) return null;
  return procArgs.slice(i + 'paper-run.js'.length).trim();
}

function tryRestart(launchArgs) {
  try {
    execSync(
      `cd ${PROJ} && setsid nohup node dist/scripts/paper-run.js ${launchArgs} >> ${LOG} 2>&1 < /dev/null &`,
      { shell: '/bin/bash', timeout: 15000, stdio: 'pipe' },
    );
    execSync('sleep 3', { timeout: 10000 });
    return findPaperProcs().length > 0;
  } catch {
    return false;
  }
}

function openSig(positions) {
  return (positions || [])
    .map((p) => `${p.symbol}:${p.direction}:${p.entry}`)
    .sort();
}

function main() {
  const state = loadState();
  const now = new Date();

  // --- report ---
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  } catch {
    verdict.ok = false;
    verdict.events.push({ type: 'report_missing', detail: `cannot read ${REPORT}` });
    console.log(JSON.stringify(verdict, null, 2));
    return;
  }
  const ageMin = (now - new Date(report.generatedAt)) / 60000;
  verdict.reportAgeMin = Math.round(ageMin * 10) / 10;
  verdict.reportFresh = ageMin <= FRESH_MIN;

  // --- process ---
  const procs = findPaperProcs();
  verdict.sessionAlive = procs.length > 0;
  const liveArgs = procs.length > 0 ? launchArgsFrom(procs[0].args) : null;

  const acct = report.account || {};
  const sig = openSig(acct.openPositions);
  const closedCount = Array.isArray(acct.tradeHistory) ? acct.tradeHistory.length : 0;

  // --- first run: baseline only ---
  if (!state.baselined) {
    saveState({
      baselined: true,
      lastCycle: report.cycle,
      lastOpenSig: sig,
      lastClosedCount: closedCount,
      launchArgs: liveArgs,
      lastSeenAliveAt: verdict.sessionAlive ? now.toISOString() : null,
      restartsToday: 0,
      restartDay: utcDay(now),
      enabled: true,
    });
    verdict.baseline = true;
    verdict.ok = verdict.sessionAlive && verdict.reportFresh;
    console.log(JSON.stringify(verdict, null, 2));
    return;
  }

  // --- keep launch args current while the session is alive ---
  if (verdict.sessionAlive && liveArgs) {
    state.launchArgs = liveArgs;
    state.lastSeenAliveAt = now.toISOString();
  }

  // --- restart logic ---
  const today = utcDay(now);
  if (state.restartDay !== today) {
    state.restartDay = today;
    state.restartsToday = 0;
  }
  if (!verdict.sessionAlive) {
    verdict.ok = false;
    const hadSeenAlive = !!state.lastSeenAliveAt;
    if (state.enabled === false) {
      verdict.events.push({ type: 'session_dead', detail: 'watchdog disabled; not restarting' });
    } else if (!hadSeenAlive || !state.launchArgs) {
      verdict.events.push({ type: 'session_dead', detail: 'no known launch command; manual restart needed' });
    } else if ((state.restartsToday || 0) >= MAX_RESTARTS_PER_DAY) {
      verdict.events.push({
        type: 'session_dead_restart_cap',
        detail: `already restarted ${state.restartsToday}x today; manual attention needed`,
      });
    } else {
      const okRestart = tryRestart(state.launchArgs);
      state.restartsToday = (state.restartsToday || 0) + 1;
      if (okRestart) {
        verdict.restarted = true;
        verdict.sessionAlive = true;
        state.lastSeenAliveAt = new Date().toISOString();
        verdict.events.push({
          type: 'session_restarted',
          detail: `paper session died; restarted with: node dist/scripts/paper-run.js ${state.launchArgs} (restart #${state.restartsToday} today)`,
        });
      } else {
        verdict.events.push({ type: 'session_dead_restart_failed', detail: 'restart attempt failed' });
      }
    }
  }

  if (verdict.sessionAlive && !verdict.reportFresh) {
    verdict.ok = false;
    verdict.events.push({
      type: 'report_stale',
      detail: `report is ${verdict.reportAgeMin} min old (cycle ${report.cycle}); session may be stuck`,
    });
  }

  // --- position events ---
  const prevSig = state.lastOpenSig || [];
  const prevSet = new Set(prevSig);
  const curSet = new Set(sig);
  const byKey = new Map((acct.openPositions || []).map((p) => [`${p.symbol}:${p.direction}:${p.entry}`, p]));
  for (const key of curSet) {
    if (!prevSet.has(key)) {
      const p = byKey.get(key) || {};
      verdict.events.push({
        type: 'position_opened',
        symbol: p.symbol,
        direction: p.direction,
        entry: p.entry,
        grade: p.grade,
        detail: `OPEN ${p.direction} ${p.symbol} @ ${p.entry} (grade ${p.grade || 'n/a'})`,
      });
    }
  }
  const prevClosed = state.lastClosedCount || 0;
  if (closedCount > prevClosed) {
    const fresh = (acct.tradeHistory || []).slice(prevClosed);
    for (const t of fresh) {
      verdict.events.push({
        type: 'position_closed',
        symbol: t.symbol,
        direction: t.direction,
        pnlQuote: t.pnlQuote,
        pnlPct: t.pnlPct,
        exitReason: t.exitReason,
        grade: t.grade,
        detail: `CLOSED ${t.direction} ${t.symbol} pnl=${Number(t.pnlQuote).toFixed(2)} (${Number(t.pnlPct).toFixed(2)}%) via ${t.exitReason}`,
      });
    }
  }

  // --- quiet-hours deferral: hold events outside 09:00–21:30 Asia/Dhaka ---
  let pending = Array.isArray(state.pendingEvents) ? state.pendingEvents : [];
  if (verdict.events.length > 0 && !inDeliveryWindow()) {
    pending = pending.concat(verdict.events);
    verdict.deferred = verdict.events.length;
    verdict.events = [];
  } else if (inDeliveryWindow() && pending.length > 0) {
    verdict.events = pending.concat(verdict.events);
    pending = [];
  }
  state.pendingEvents = pending;

  // --- persist ---
  state.lastCycle = report.cycle;
  state.lastOpenSig = sig;
  state.lastClosedCount = closedCount;
  saveState(state);

  console.log(JSON.stringify(verdict, null, 2));
}

main();
