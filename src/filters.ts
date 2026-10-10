/**
 * CryptoAI Pro — Master Signal Engine: filters.
 *
 * Data validation, liquidity gating, BTC/ETH market context, portfolio
 * correlation, signal quality tiers, anti-overtrading cooldowns, and a
 * RULES-BASED AI confirmation layer.
 *
 * ---------------------------------------------------------------------------
 * AI LAYER — READ BEFORE INTEGRATING
 * ---------------------------------------------------------------------------
 * The "AI" here is a deterministic rules engine over structured features.
 * It makes NO external calls (no LLM, no API, no network, no randomness) and
 * is a pure function: same features in, same rating out.
 *
 * It CANNOT override hard risk rules. Mechanism:
 *   1. aiConfirm() only returns an advisory rating ('AI_BULLISH' |
 *      'AI_BEARISH' | 'AI_NEUTRAL'). It has no access to emission, sizing,
 *      or gating decisions.
 *   2. Strong-opposition flags (btcViolentDump, btcStrongBull) act as
 *      ONE-WAY VETOES: they can only demote a directional rating to
 *      AI_NEUTRAL. They can never promote, force, or permit a trade.
 *   3. The engine must treat ai_rating as confirmation only. Hard gates —
 *      minScore / minConfidence / minRR floors, liquidity.ok, cooldowns,
 *      regime cooldowns, and invalidation — remain authoritative and must
 *      never be waived or relaxed on the basis of any AI rating.
 *
 * Nothing in this module claims or implies guaranteed accuracy. Scores,
 * confidence values, and probability estimates are model-derived estimates
 * used for ranking and gating, never promises of outcome.
 *
 * Integration assumptions (indicators.ts / regime.ts are parallel work):
 *   computeIndicators(candles: Candle[]): IndicatorSet
 *   lastFinite(values: number[]): number            (NaN when none finite)
 *   detectRegime(candles: Candle[], ind: IndicatorSet): RegimeDetection | MarketRegime
 * Runtime normalization accepts either return shape of detectRegime.
 */
import type {
  Candle,
  EngineConfig,
  LiquidityCheck,
  MarketContext,
  MarketRegime,
  AIFeatures,
  AIRating,
  SignalGrade,
  MasterSignal,
  Direction,
  Timeframe,
  IndicatorSet,
  MTFAnalysis,
  CandleValidation,
} from './types';
import { computeIndicators, lastFinite } from './indicators';
import { detectRegime } from './regime';

// ---------------------------------------------------------------------------
// Shared helpers (module-private)
// ---------------------------------------------------------------------------

const MS_24H = 24 * 3600 * 1000;
const PRUNE_AFTER_MS = 24 * 3600 * 1000;

/** Bullish-leaning regimes for cooldown alignment and AI voting. */
const BULL_REGIMES: readonly MarketRegime[] = [
  'STRONG_BULL',
  'WEAK_BULL',
  'BREAKOUT',
  'ACCUMULATION',
];

/** Bearish-leaning regimes for cooldown alignment and AI voting. */
const BEAR_REGIMES: readonly MarketRegime[] = [
  'STRONG_BEAR',
  'WEAK_BEAR',
  'BREAKDOWN',
  'DISTRIBUTION',
];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Abnormal candle: range > 5x median range AND volume > 3x median volume. */
function isAbnormalCandle(c: Candle, medianRange: number, medianVolume: number): boolean {
  if (!(medianRange > 0)) return false;
  const range = c.high - c.low;
  return range > 5 * medianRange && c.volume > 3 * medianVolume;
}

/** Wick-dominated: wicks account for more than 60% of the candle range. */
function isWickDominated(c: Candle): boolean {
  const range = c.high - c.low;
  if (!(range > 0)) return false;
  const body = Math.abs(c.close - c.open);
  return (range - body) / range > 0.6;
}

function directionAlignsWithRegime(direction: Direction, regime: MarketRegime): boolean {
  if (direction === 'LONG') return (BULL_REGIMES as readonly string[]).includes(regime);
  if (direction === 'SHORT') return (BEAR_REGIMES as readonly string[]).includes(regime);
  return false;
}

/**
 * Normalize detectRegime's return to a MarketRegime. Accepts either a raw
 * MarketRegime string or a RegimeDetection-shaped object ({ regime }).
 */
function toMarketRegime(result: unknown): MarketRegime {
  if (typeof result === 'string') return result as MarketRegime;
  if (result !== null && typeof result === 'object' && 'regime' in result) {
    const r = (result as { regime?: unknown }).regime;
    if (typeof r === 'string') return r as MarketRegime;
  }
  return 'SIDEWAYS';
}

// ---------------------------------------------------------------------------
// 1. Candle data validation
// ---------------------------------------------------------------------------

/**
 * Validate and clean a candle series. Never throws: on unexpected input it
 * returns an empty series with an explanatory issue.
 *
 * Steps: drop invalid rows (non-finite/negative OHLCV or openTime, high<low,
 * zero-range + zero-volume anomalies) -> de-duplicate by openTime (keep first
 * occurrence) -> sort ascending by openTime -> detect gaps (interval inferred
 * from the median delta) -> flag abnormal candles (range > 5x median range
 * with volume > 3x median volume).
 */
export function validateCandleData(candles: Candle[]): CandleValidation {
  const issues: string[] = [];
  try {
    if (!Array.isArray(candles)) {
      return { candles: [], issues: ['Input is not an array of candles.'], dropped: 0 };
    }
    const inputLength = candles.length;

    // 1. Drop invalid rows.
    const valid: Candle[] = [];
    for (const c of candles) {
      if (c === null || typeof c !== 'object') continue;
      const ohlcv = [c.open, c.high, c.low, c.close, c.volume];
      const ohlcvOk = ohlcv.every((v) => Number.isFinite(v) && v >= 0);
      const timeOk = Number.isFinite(c.openTime);
      if (!ohlcvOk || !timeOk) continue;
      if (c.high < c.low) continue;
      if (c.high === c.low && c.volume === 0) continue; // zero-range + zero-volume anomaly
      valid.push(c);
    }

    // 2. De-duplicate by openTime, keeping the first occurrence.
    const seen = new Set<number>();
    const deduped: Candle[] = [];
    let dupCount = 0;
    for (const c of valid) {
      if (seen.has(c.openTime)) {
        dupCount++;
        continue;
      }
      seen.add(c.openTime);
      deduped.push(c);
    }

    // 3. Sort ascending by openTime.
    deduped.sort((a, b) => a.openTime - b.openTime);

    const dropped = inputLength - deduped.length;
    if (inputLength - valid.length > 0) {
      issues.push(
        `Dropped ${inputLength - valid.length} invalid candle row(s) ` +
          '(non-finite/negative OHLCV, high<low, or zero-range/zero-volume).',
      );
    }
    if (dupCount > 0) {
      issues.push(`Removed ${dupCount} duplicate openTime row(s) (kept first occurrence).`);
    }

    // 4. Gap detection: infer the expected interval from the median delta.
    if (deduped.length >= 3) {
      const deltas: number[] = [];
      for (let i = 1; i < deduped.length; i++) {
        const d = deduped[i].openTime - deduped[i - 1].openTime;
        if (d > 0) deltas.push(d);
      }
      const expected = median(deltas);
      if (expected > 0) {
        let gapCount = 0;
        let missingTotal = 0;
        for (let i = 1; i < deduped.length; i++) {
          const d = deduped[i].openTime - deduped[i - 1].openTime;
          if (d > expected * 1.5) {
            const missing = Math.max(1, Math.round(d / expected) - 1);
            gapCount++;
            missingTotal += missing;
          }
        }
        if (gapCount > 0) {
          issues.push(
            `Data gaps detected: ${gapCount} gap(s), ~${missingTotal} missing candle(s) ` +
              `(inferred interval ${expected} ms).`,
          );
        }
      }
    }

    // 5. Flag abnormal candles.
    if (deduped.length >= 5) {
      const medRange = median(deduped.map((c) => c.high - c.low));
      const medVol = median(deduped.map((c) => c.volume));
      const abnormal = deduped.filter((c) => isAbnormalCandle(c, medRange, medVol)).length;
      if (abnormal > 0) {
        issues.push(
          `Flagged ${abnormal} abnormal candle(s): range > 5x median range ` +
            'with volume > 3x median volume.',
        );
      }
    }

    return { candles: deduped, issues, dropped };
  } catch (err) {
    issues.push(
      `Validation failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      candles: [],
      issues,
      dropped: Array.isArray(candles) ? candles.length : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Liquidity filter
// ---------------------------------------------------------------------------

/**
 * Liquidity gate for one symbol. Score starts at 100 and loses 25 per issue
 * (floored at 0); ok is true only when there are no issues.
 *
 * Issues: 'Low volume' (quoteVolume24h < minQuoteVolume24h), 'Wide spread'
 * (spreadPct > maxSpreadPct), 'Abnormal candles' (any of the last 5 candles
 * abnormal), 'Insufficient liquidity' (latest volume < 40% of the 20-bar
 * median volume), 'Suspicious price movement' (>40% of the last 20 candles
 * wick-dominated).
 */
export function checkLiquidity(
  candles: Candle[],
  quoteVolume24h: number,
  spreadPct: number,
  config: EngineConfig,
): LiquidityCheck {
  const issues: string[] = [];
  const series = Array.isArray(candles)
    ? [...candles].sort((a, b) => a.openTime - b.openTime)
    : [];

  if (!Number.isFinite(quoteVolume24h) || quoteVolume24h < config.minQuoteVolume24h) {
    issues.push('Low volume');
  }
  if (!Number.isFinite(spreadPct) || spreadPct > config.maxSpreadPct) {
    issues.push('Wide spread');
  }

  if (series.length === 0) {
    issues.push('Insufficient candle data');
  } else {
    // Abnormal candles among the last 5.
    const tail = series.slice(-5);
    const medRange = median(series.map((c) => c.high - c.low));
    const medVol = median(series.map((c) => c.volume));
    if (tail.some((c) => isAbnormalCandle(c, medRange, medVol))) {
      issues.push('Abnormal candles');
    }

    // Volume declining to < 40% of the 20-bar median.
    const vols20 = series.slice(-20).map((c) => c.volume);
    if (vols20.length >= 5) {
      const med = median(vols20);
      const lastVol = series[series.length - 1].volume;
      if (med > 0 && lastVol < 0.4 * med) {
        issues.push('Insufficient liquidity');
      }
    }

    // Wick-dominated candles in the last 20: a high share of dojis/spinning
    // tops suggests choppy, possibly manipulated price action. The bar is
    // deliberately high (>40%) — an occasional wick-dominated candle is normal.
    const last20 = series.slice(-20);
    const wicked = last20.filter(isWickDominated).length;
    if (last20.length > 0 && wicked / last20.length > 0.4) {
      issues.push('Suspicious price movement');
    }
  }

  const score = Math.max(0, 100 - 25 * issues.length);
  return {
    ok: issues.length === 0,
    quoteVolume24h,
    spreadPct,
    score,
    issues,
  };
}

// ---------------------------------------------------------------------------
// 3. BTC/ETH market context filter
// ---------------------------------------------------------------------------

/** 24h percentage change: explicit override wins, otherwise derived from candles. */
function change24hPct(candles: Candle[], explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
  if (candles.length < 2) return 0;
  const closes = candles.map((c) => c.close);
  const lastClose = lastFinite(closes);
  const lastTime = candles[candles.length - 1].openTime;
  const cutoff = lastTime - MS_24H;
  let refClose = candles[0].close;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].openTime <= cutoff) {
      refClose = candles[i].close;
      break;
    }
  }
  if (!Number.isFinite(lastClose) || !Number.isFinite(refClose) || refClose === 0) return 0;
  return ((lastClose - refClose) / refClose) * 100;
}

/**
 * Market-wide context from BTC/ETH 1h candles: regime per asset plus
 * violent-dump / strong-bull flags the engine uses as hard filters.
 * Empty inputs yield SIDEWAYS regimes and false flags.
 */
export function buildMarketContext(
  btcCandles: Candle[],
  ethCandles: Candle[],
  btcChange24hPct?: number,
  ethChange24hPct?: number,
): MarketContext {
  // Context is computed on 1h candles.
  const contextTimeframe: Timeframe = '1h';
  void contextTimeframe;

  const btc = validateCandleData(Array.isArray(btcCandles) ? btcCandles : []).candles;
  const eth = validateCandleData(Array.isArray(ethCandles) ? ethCandles : []).candles;

  let btcRegime: MarketRegime = 'SIDEWAYS';
  if (btc.length > 0) {
    const ind: IndicatorSet = computeIndicators(btc);
    btcRegime = toMarketRegime(detectRegime(btc, ind));
  }

  let ethRegime: MarketRegime = 'SIDEWAYS';
  if (eth.length > 0) {
    const ind: IndicatorSet = computeIndicators(eth);
    ethRegime = toMarketRegime(detectRegime(eth, ind));
  }

  const btcChg = change24hPct(btc, btcChange24hPct);
  const ethChg = change24hPct(eth, ethChange24hPct);

  return {
    btcRegime,
    ethRegime,
    btcChange24hPct: btcChg,
    ethChange24hPct: ethChg,
    btcViolentDump: btcChg < -5,
    btcStrongBull: btcRegime === 'STRONG_BULL' && btcChg > 3,
    ethViolentDump: ethChg < -5,
  };
}

// ---------------------------------------------------------------------------
// 4. Portfolio correlation
// ---------------------------------------------------------------------------

/**
 * Portfolio correlation exposure: share of currently active signals pointing
 * the same direction, 0..100. 0 when nothing is active.
 */
export function correlationScore(sameDirectionActive: number, totalActive: number): number {
  if (!Number.isFinite(totalActive) || totalActive <= 0) return 0;
  if (!Number.isFinite(sameDirectionActive) || sameDirectionActive <= 0) return 0;
  return Math.round((sameDirectionActive / totalActive) * 100);
}

// ---------------------------------------------------------------------------
// 5. Signal quality tiers
// ---------------------------------------------------------------------------

/**
 * Grade a scored signal.
 *
 *   NO_TRADE — best directional score below config.minScore. The engine must
 *              not trade this; it is the strict protection default.
 *   A+       — elite tier: score >= aPlusScore, confidence >= aPlusConfidence,
 *              rr >= aPlusRR, MTF agreement >= 70, liquidity score >= 80.
 *   A        — tradable tier: score >= minScore, confidence >= minConfidence,
 *              rr >= minRR.
 *   B        — below A thresholds. B signals MUST NOT auto-trade; they are
 *              informational/watchlist only and require manual review.
 *
 * No grade implies any guaranteed outcome — grades rank estimated setup
 * quality for gating and sizing, nothing more.
 */
export function gradeSignal(
  longScore: number,
  shortScore: number,
  confidence: number,
  rr: number,
  mtf: MTFAnalysis,
  liquidity: LiquidityCheck,
  config: EngineConfig,
): SignalGrade {
  const score = Math.max(longScore, shortScore);
  // NORMAL tier: 65-80 scores get NORMAL grade (tracked separately)
  if (score >= config.normalMinScore && score <= config.normalMaxScore) {
    return 'NORMAL';
  }
  if (!(score >= config.minScore)) return 'NO_TRADE';

  const aPlus =
    score >= config.aPlusScore &&
    confidence >= config.aPlusConfidence &&
    rr >= config.aPlusRR &&
    mtf.agreement >= 70 &&
    liquidity.score >= 80;
  if (aPlus) return 'A+';

  const aTier =
    score >= config.minScore &&
    confidence >= config.minConfidence &&
    rr >= config.minRR;
  if (aTier) return 'A';

  return 'B';
}

// ---------------------------------------------------------------------------
// 6. Rules-based AI confirmation layer (NO external calls)
// ---------------------------------------------------------------------------

/**
 * Rules-based confirmation vote over structured features. Pure function:
 * no I/O, no network, no randomness — identical input always yields the
 * identical rating.
 *
 * Ten bullish votes and ten mirrored bearish votes (each weight 1), e.g.
 * MTF score beyond +/-25, directional score gap > 10, regime membership,
 * RSI extremes, MACD histogram sign, ADX > 20 trend strength, volume ratio >
 * 1.2, VWAP position, rr >= 2, and absence of opposing BTC extremes.
 * net = bullVotes - bearVotes: > 2 => AI_BULLISH, < -2 => AI_BEARISH,
 * otherwise AI_NEUTRAL.
 *
 * Strong-opposition veto (one-way, demote-only): btcViolentDump caps a
 * bullish verdict at AI_NEUTRAL; btcStrongBull caps a bearish verdict at
 * AI_NEUTRAL. These flags can NEVER create or upgrade a directional rating.
 *
 * The returned rating is advisory confirmation only. It must never override
 * hard risk rules — see the module header.
 */
export function aiConfirm(f: AIFeatures): AIRating {
  let bull = 0;
  let bear = 0;

  // Bullish votes.
  if (f.mtfScore > 25) bull++;
  if (f.longScore > f.shortScore + 10) bull++;
  if ((BULL_REGIMES as readonly string[]).includes(f.regime)) bull++;
  if (f.rsi > 55) bull++;
  if (f.macdHist > 0) bull++;
  if (f.adx > 20) bull++;
  if (f.volumeRatio > 1.2) bull++;
  if (f.vwapPosition === 'ABOVE') bull++; // long context: price above VWAP
  if (f.rr >= 2) bull++;
  if (!f.btcViolentDump) bull++;

  // Bearish votes (mirror).
  if (f.mtfScore < -25) bear++;
  if (f.shortScore > f.longScore + 10) bear++;
  if ((BEAR_REGIMES as readonly string[]).includes(f.regime)) bear++;
  if (f.rsi < 45) bear++;
  if (f.macdHist < 0) bear++;
  if (f.adx > 20) bear++;
  if (f.volumeRatio > 1.2) bear++;
  if (f.vwapPosition === 'BELOW') bear++; // short context: price below VWAP
  if (f.rr >= 2) bear++;
  if (!f.btcStrongBull) bear++;

  const net = bull - bear;
  let rating: AIRating = net > 2 ? 'AI_BULLISH' : net < -2 ? 'AI_BEARISH' : 'AI_NEUTRAL';

  // One-way veto: strong opposition can only demote to NEUTRAL, never promote.
  if (rating === 'AI_BULLISH' && f.btcViolentDump) rating = 'AI_NEUTRAL';
  if (rating === 'AI_BEARISH' && f.btcStrongBull) rating = 'AI_NEUTRAL';

  return rating;
}

// ---------------------------------------------------------------------------
// 7. Default invalidation rules
// ---------------------------------------------------------------------------

/**
 * Default invalidation checklist per direction — conditions under which an
 * active signal must be treated as invalidated. These are static rules, not
 * predictions; they describe what would disprove the setup.
 */
export function defaultInvalidation(direction: Direction): string[] {
  if (direction === 'SHORT') {
    return [
      'Price closes above entry structure',
      'Stop loss invalidated',
      'EMA structure flips bullish',
      'Opposite BOS occurs',
      'Market regime changes against position',
      'BTC breaks major resistance',
      'Signal expired',
    ];
  }
  if (direction === 'LONG') {
    return [
      'Price closes below entry structure',
      'Stop loss invalidated',
      'EMA structure flips bearish',
      'Opposite BOS occurs',
      'Market regime changes against position',
      'BTC breaks major support',
      'Signal expired',
    ];
  }
  // NO_TRADE carries no position; only lifecycle/regime conditions apply.
  return ['Signal expired', 'Market regime changes against position'];
}

// ---------------------------------------------------------------------------
// 8. Anti-overtrading cooldowns
// ---------------------------------------------------------------------------

interface EmissionRecord {
  time: number;
  direction: Direction;
  regime: MarketRegime;
}

/**
 * Anti-overtrading cooldown tracker.
 *
 * - Per-symbol last emission: blocks re-emission for a symbol within
 *   config.cooldownMs ('Signal cooldown active').
 * - Per-symbol same-direction: blocks the same direction for a symbol within
 *   config.sameDirectionCooldownMs ('Same-direction cooldown').
 * - Global regime shift: when the market regime changes (observed via
 *   canEmit's regime argument or a recorded signal), emissions whose
 *   direction aligns with the OLD regime are blocked for
 *   config.regimeCooldownMs ('Market regime cooldown') — the engine must not
 *   keep trading the previous trend into a new regime.
 *
 * record() stores {time, direction, regime} per symbol and prunes entries
 * older than 24h. activeCount() counts symbols whose cooldown has not yet
 * expired. AI ratings play no role here: cooldowns are hard gates.
 */
export class CooldownTracker {
  private readonly config: EngineConfig;
  private readonly emissions = new Map<string, EmissionRecord>();
  private globalRegime: MarketRegime = 'SIDEWAYS';
  private previousRegime: MarketRegime | null = null;
  private lastRegimeShiftAt: number | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  canEmit(
    symbol: string,
    direction: Direction,
    regime: MarketRegime,
    now?: number,
  ): { ok: boolean; reason?: string } {
    const t = Number.isFinite(now) ? (now as number) : Date.now();

    // Observe regime changes at check time: the market shifted even if no
    // signal was emitted under the old regime.
    this.observeRegime(regime, t);
    this.prune(t);

    const prev = this.emissions.get(symbol);
    if (prev) {
      const elapsed = Math.max(0, t - prev.time);
      if (elapsed < this.config.cooldownMs) {
        return { ok: false, reason: 'Signal cooldown active' };
      }
      if (prev.direction === direction && elapsed < this.config.sameDirectionCooldownMs) {
        return { ok: false, reason: 'Same-direction cooldown' };
      }
    }

    if (
      this.previousRegime !== null &&
      this.lastRegimeShiftAt !== null &&
      Math.max(0, t - this.lastRegimeShiftAt) < this.config.regimeCooldownMs &&
      directionAlignsWithRegime(direction, this.previousRegime)
    ) {
      return { ok: false, reason: 'Market regime cooldown' };
    }

    return { ok: true };
  }

  record(signal: MasterSignal): void {
    const parsed = Date.parse(signal.created_at);
    const t = Number.isFinite(parsed) ? parsed : Date.now();
    this.emissions.set(signal.symbol, {
      time: t,
      direction: signal.direction,
      regime: signal.market_regime,
    });
    this.observeRegime(signal.market_regime, t);
    this.prune(t);
  }

  activeCount(): number {
    const t = Date.now();
    this.prune(t);
    let n = 0;
    for (const e of this.emissions.values()) {
      if (Math.max(0, t - e.time) < this.config.cooldownMs) n++;
    }
    return n;
  }

  private observeRegime(regime: MarketRegime, t: number): void {
    if (regime !== this.globalRegime) {
      this.previousRegime = this.globalRegime;
      this.globalRegime = regime;
      this.lastRegimeShiftAt = t;
    }
  }

  private prune(t: number): void {
    for (const [symbol, e] of this.emissions) {
      if (t - e.time > PRUNE_AFTER_MS) this.emissions.delete(symbol);
    }
  }
}
