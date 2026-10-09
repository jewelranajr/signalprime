# CryptoAI Pro — Master Signal Engine

A production-grade crypto signal engine: multi-timeframe analysis, market-regime
detection, weighted LONG/SHORT scoring with contradiction penalties, false-breakout
protection, structure-based entries/stops/targets, risk-derived position sizing,
liquidity + BTC/ETH + correlation filters, quality tiers, cooldowns, a rules-based
AI confirmation layer, backtesting, and paper trading — exposed through a Fastify API.

## Objective

**Maximum validated signal quality with strict NO_TRADE protection and controlled risk.**

The engine never forces a signal. When evidence is insufficient, the correct answer
is `NO_TRADE` — with informative reasons. Nothing in this system claims, implies,
or estimates guaranteed accuracy: `probability_estimate` is a model-derived
confidence estimate based on historical/validated conditions, never a promise.

## Architecture

```
src/
  types.ts        # Shared contracts (MasterSignal JSON schema, config, candles, …)
  config.ts       # Env-driven EngineConfig + sanitized public config
  indicators.ts   # Pure, causal indicators: EMA/RSI/MACD/ATR/ADX/VWAP/Bollinger,
                  #   swings, HH/HL/LH/LL structure, BOS/CHoCH, liquidity sweeps,
                  #   FVG, order blocks. No look-ahead: index i uses only data ≤ i.
  exchange.ts     # Binance PUBLIC market-data client (no API keys, ever):
                  #   base-URL failover, caching, concurrency cap, retries/backoff,
                  #   429/418 hard-stop. One bad symbol never fails the batch.
  regime.ts       # Multi-timeframe engine (1d 15% / 4h 25% / 1h 25% / 15m 20% /
                  #   5m 15%) + market-regime detection. Never confirms against HTF.
  risk.ts         # Entry zones (LIMIT/MARKET/BREAKOUT/RETEST), structure-based SL
                  #   with ATR buffer, TP1/TP2/TP3 + per-TP RR, position sizing from
                  #   stop distance (never scaled by confidence), risk-capped leverage.
  filters.ts      # Candle validation, liquidity filter, BTC/ETH market filter,
                  #   correlation scoring, A+/A/B/NO_TRADE tiers, CooldownTracker,
                  #   rules-based AI confirmation (advisory only — cannot override
                  #   hard risk rules).
  engine.ts       # Master decision (spec §29): scoring 0–100 per side with
                  #   contradiction penalties, confidence (not raw score),
                  #   hard-risk-failure → NO_TRADE, full MasterSignal assembly.
  backtest.ts     # No-look-ahead backtest (worst-case intra-bar fills, fees,
                  #   partials 40/30/30) + walk-forward validation + overfit flag.
  paper.ts        # PaperTrader (virtual balance, SL/TP settlement, funding,
                  #   slippage, fees) + canGoLive() validation gate.
  server.ts       # Fastify API + rate limiting + input validation.
  index.ts        # Bootstrap.
  scripts/        # sample.js (live signals), synthetic.js (LONG/SHORT fixtures),
                  #   backtest-run.js (historical validation)
  tests/          # 49 unit tests (node:test), incl. causality / no-look-ahead proofs
```

## Quick start

```bash
npm install
npm run build
cp .env.example .env   # adjust thresholds if needed

# Live signals (strict default config — NO_TRADE is a valid, expected outcome)
npm run sample -- BTCUSDT ETHUSDT SOLUSDT

# Synthetic LONG + SHORT fixtures (relaxed, documented thresholds)
node dist/scripts/synthetic.js

# Historical backtest + walk-forward validation
npm run backtest -- BTCUSDT 1000

# API server
npm start
# GET /api/health  /api/config  /api/signal/:symbol  /api/signals?limit=20  /api/market/:symbol

# Tests (build + node:test)
npm test
```

## Master signal filter (defaults, all env-configurable)

| Variable | Default | Meaning |
|---|---|---|
| `MIN_SCORE` | 85 | min long/short score (0–100) |
| `MIN_CONFIDENCE` | 80 | min confidence (not raw score) |
| `MIN_DIRECTION_GAP` | 10 | min \|long − short\|, else NO_TRADE |
| `MIN_RR` | 2.0 | min risk/reward on primary target |
| `A_PLUS_SCORE` / `A_PLUS_CONFIDENCE` / `A_PLUS_RR` | 92 / 88 / 2.5 | A+ tier bar |
| `RISK_PERCENT` | 1 | account risk per trade |
| `MAX_LEVERAGE` / `BASE_LEVERAGE` | 10 / 3 | leverage caps (reduced in volatility; 0 = NO_TRADE) |

**B-tier signals are informational only and must never auto-trade.**

## Risk rules (hard)

- `risk_amount = balance × riskPercent / 100`; quantity derives from stop distance.
  Size never scales with confidence or score.
- Leverage never changes intended account risk; extreme volatility → NO_TRADE.
- Stop-loss is structure-based (swing/support/resistance ± ATR buffer), never random.
- One bad symbol, one bad candle batch, one API failure → safe `NO_TRADE`, never a crash.

## What this is not

- Not a predictor with a claimed win rate. Backtest metrics describe historical
  simulation only; past performance does not predict future results.
- Not a live-trading system: this codebase places **no** live orders. `canGoLive()`
  requires paper-validation (≥30 trades, PF ≥ 1.2, maxDD ≤ 25%, expectancy > 0,
  selectivity ≥ 20% NO_TRADE) before any live consideration — and live execution
  itself is out of scope here.
- No secrets exist in this system: only Binance public endpoints are used.
