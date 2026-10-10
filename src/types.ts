/**
 * CryptoAI Pro — Master Signal Engine: shared types.
 *
 * Design objective: maximum validated signal quality with strict NO_TRADE
 * protection and controlled risk. Nothing in this system claims, implies, or
 * estimates guaranteed accuracy. probability_estimate is a model-derived
 * confidence estimate, not a promise of outcome.
 */

// ---------------------------------------------------------------------------
// Market data primitives
// ---------------------------------------------------------------------------

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

/** MTF weighting: 1d=15%, 4h=25%, 1h=25%, 15m=20%, 5m=15% (1m is entry timing, folded into 5m). */
export const MTF_WEIGHTS: Record<Timeframe, number> = {
  '1d': 0.15,
  '4h': 0.25,
  '1h': 0.25,
  '15m': 0.2,
  '5m': 0.15,
  '1m': 0.0,
};

export interface Candle {
  openTime: number; // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number; // ms epoch
}

// ---------------------------------------------------------------------------
// Signal domain
// ---------------------------------------------------------------------------

export type Direction = 'LONG' | 'SHORT' | 'NO_TRADE';
export type SignalGrade = 'A+' | 'A' | 'B' | 'NO_TRADE';
export type SignalStatus = 'ACTIVE' | 'WAITING' | 'EXPIRED' | 'INVALIDATED';
export type EntryType = 'LIMIT' | 'MARKET' | 'BREAKOUT' | 'RETEST' | 'WAIT_FOR_RETEST';
export type AIRating = 'AI_BULLISH' | 'AI_BEARISH' | 'AI_NEUTRAL';
export type TFBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type MarketRegime =
  | 'STRONG_BULL'
  | 'WEAK_BULL'
  | 'STRONG_BEAR'
  | 'WEAK_BEAR'
  | 'SIDEWAYS'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'BREAKOUT'
  | 'BREAKDOWN'
  | 'ACCUMULATION'
  | 'DISTRIBUTION'
  | 'POSSIBLE_MANIPULATION';

// ---------------------------------------------------------------------------
// Indicator structures (src/indicators.ts)
// ---------------------------------------------------------------------------

export interface SwingPoint {
  index: number;
  price: number;
  time: number;
}

export type StructureLabel = 'HH' | 'HL' | 'LH' | 'LL';

export interface StructurePoint extends SwingPoint {
  label: StructureLabel;
}

export interface BreakEvent {
  index: number;
  time: number;
  price: number;
  brokenLevel: number;
  direction: 'UP' | 'DOWN';
  volumeConfirmed: boolean;
}

export interface LiquiditySweep {
  index: number;
  time: number;
  side: 'BUY_SIDE' | 'SELL_SIDE';
  sweptLevel: number;
  wicked: boolean;
  reclaimed: boolean;
}

export interface FairValueGap {
  index: number;
  time: number;
  top: number;
  bottom: number;
  direction: 'BULLISH' | 'BEARISH';
  filled: boolean;
}

export interface OrderBlock {
  index: number;
  time: number;
  top: number;
  bottom: number;
  direction: 'BULLISH' | 'BEARISH';
  mitigated: boolean;
}

export interface MACDResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

export interface ADXResult {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
  percentB: number[];
}

/**
 * Full indicator set for one candle series. Every array is aligned to the
 * input candles by index; values are computed ONLY from data at or before
 * that index (no look-ahead). Uncomputable prefix entries are NaN.
 */
export interface IndicatorSet {
  ema20: number[];
  ema50: number[];
  ema100: number[];
  ema200: number[];
  rsi: number[];
  macd: MACDResult;
  atr: number[];
  adx: ADXResult;
  vwap: number[];
  bollinger: BollingerResult;
  volumeSMA: number[];
  support: number[];
  resistance: number[];
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  structure: StructurePoint[];
  bos: BreakEvent[];
  choch: BreakEvent[];
  liquiditySweeps: LiquiditySweep[];
  fvg: FairValueGap[];
  orderBlocks: OrderBlock[];
}

// ---------------------------------------------------------------------------
// Multi-timeframe analysis (src/regime.ts)
// ---------------------------------------------------------------------------

export interface TimeframeView {
  timeframe: Timeframe;
  bias: TFBias;
  /** -100 (fully bearish) .. +100 (fully bullish) */
  score: number;
  weight: number;
  emaBullish: boolean;
  rsi: number;
  adx: number;
}

export interface MTFAnalysis {
  views: Record<Timeframe, TimeframeView>;
  /** Weighted score across timeframes, -100..+100. */
  weightedScore: number;
  /** Higher-timeframe bias from 1d/4h. */
  htfBias: TFBias;
  /** 0..100 — how aligned the timeframe biases are. */
  agreement: number;
  confirmsLong: boolean;
  confirmsShort: boolean;
}

export interface RegimeDetection {
  regime: MarketRegime;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Scoring (src/engine.ts)
// ---------------------------------------------------------------------------

export interface ScoreComponent {
  name: string;
  long: number;
  short: number;
  max: number;
}

export interface ScorePenalty {
  name: string;
  long: number;
  short: number;
  reason: string;
}

export interface ScoreBreakdown {
  long: number; // 0..100
  short: number; // 0..100
  components: ScoreComponent[];
  penalties: ScorePenalty[];
  directionGap: number; // abs(long - short)
}

// ---------------------------------------------------------------------------
// Engine configuration (src/config.ts)
// ---------------------------------------------------------------------------

export interface EngineConfig {
  // Master signal filter
  minScore: number;
  minConfidence: number;
  minDirectionGap: number;
  minRR: number;
  // A+ tier thresholds
  aPlusScore: number;
  aPlusConfidence: number;
  aPlusRR: number;
  // Risk
  accountBalance: number;
  riskPercent: number;
  maxLeverage: number;
  baseLeverage: number;
  // Data / lifecycle
  minCandles: number;
  signalTtlMs: number;
  cooldownMs: number;
  sameDirectionCooldownMs: number;
  regimeCooldownMs: number;
  // Liquidity filter
  maxSpreadPct: number;
  minQuoteVolume24h: number;
  // Exchange data layer
  binanceBaseUrls: string[];
  requestTimeoutMs: number;
  maxRetries: number;
  cacheTtlMs: number;
  maxConcurrency: number;
  // Paper trading
  paperEnabled: boolean;
  paperStartBalance: number;
  paperFeePct: number;
  paperSlippagePct: number;
  paperFundingPct8h: number;
  // API
  apiPort: number;
  apiHost: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

// ---------------------------------------------------------------------------
// Filters & context (src/filters.ts)
// ---------------------------------------------------------------------------

export interface LiquidityCheck {
  ok: boolean;
  quoteVolume24h: number;
  spreadPct: number;
  score: number; // 0..100
  issues: string[];
}

export interface MarketContext {
  btcRegime: MarketRegime;
  ethRegime: MarketRegime;
  btcChange24hPct: number;
  ethChange24hPct: number;
  btcViolentDump: boolean;
  btcStrongBull: boolean;
  ethViolentDump: boolean;
  /** V2: funding rate data for contrarian signals (optional). */
  fundingRate?: number;
  fundingRateZScore?: number; // standardized: >2 = extremely crowded long, <-2 = extremely crowded short
}

/** Structured features consumed by the rules-based AI confirmation layer. */
export interface AIFeatures {
  mtfScore: number;
  longScore: number;
  shortScore: number;
  regime: MarketRegime;
  rsi: number;
  macdHist: number;
  adx: number;
  volumeRatio: number;
  vwapPosition: 'ABOVE' | 'BELOW' | 'NEAR';
  atrPct: number;
  liquidityScore: number;
  btcViolentDump: boolean;
  btcStrongBull: boolean;
  rr: number;
}

export interface CandleValidation {
  candles: Candle[];
  issues: string[];
  dropped: number;
}

// ---------------------------------------------------------------------------
// Trade planning (src/risk.ts)
// ---------------------------------------------------------------------------

export interface EntryPlan {
  low: number;
  high: number;
  preferred: number;
  type: EntryType;
  reason: string;
}

export interface StopLossPlan {
  price: number;
  distance_percent: number;
  reason: string;
}

export interface TakeProfitPlan {
  tp1: number;
  tp2: number;
  tp3: number;
  reasons: string[];
}

export interface RiskReward {
  tp1: number;
  tp2: number;
  tp3: number;
}

export interface PositionPlan {
  risk_percent: number;
  risk_amount: number;
  quantity: number;
  notional: number;
  leverage: number;
}

// ---------------------------------------------------------------------------
// Master signal output (spec section 30). NO_TRADE uses the same shape with
// direction='NO_TRADE', status='WAITING', and null trade fields (section 31).
// ---------------------------------------------------------------------------

export interface MasterSignal {
  signal_id: string;
  symbol: string;
  direction: Direction;
  status: SignalStatus;
  signal_grade: SignalGrade;
  long_score: number;
  short_score: number;
  confidence: number; // 0..100, NOT the raw score
  probability_estimate: number; // 0..100 model-derived estimate, never a guarantee
  probability_note: string;
  market_regime: MarketRegime;
  entry: EntryPlan | null;
  stop_loss: StopLossPlan | null;
  take_profit: TakeProfitPlan | null;
  risk_reward: RiskReward | null;
  position: PositionPlan | null;
  mtf: Record<Timeframe, TFBias>;
  confirmation: {
    trend: boolean;
    structure: boolean;
    momentum: boolean;
    volume: boolean;
    vwap: boolean;
    breakout: boolean;
    liquidity: boolean;
  };
  reasons: string[];
  warnings: string[];
  invalidation: string[];
  correlation_score: number; // 0..100 portfolio correlation exposure
  ai_rating: AIRating;
  created_at: string;
  expires_at: string;
}

/** Input bundle the engine needs for one symbol. */
export interface SymbolInput {
  symbol: string;
  candles: Record<Timeframe, Candle[]>;
  quoteVolume24h: number;
  spreadPct: number;
}

export interface EngineDeps {
  config: EngineConfig;
  market: MarketContext;
  balance: number;
  now?: number;
}

// ---------------------------------------------------------------------------
// Backtesting (src/backtest.ts)
// ---------------------------------------------------------------------------

export interface BacktestTrade {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  grade: SignalGrade;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  entryTime: number;
  exitTime: number;
  exitReason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED' | 'INVALIDATED' | 'MANUAL';
  pnlPct: number;
  pnlQuote: number;
  rrRealized: number;
  fees: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  candlesEvaluated: number;
  signalsGenerated: number;
  /** 0..100 percent of evaluations that correctly returned NO_TRADE. */
  noTradePct: number;
  /** Fractions 0..1 (multiply by 100 for display). */
  winRate: number;
  /** Fractions 0..1 (multiply by 100 for display). */
  lossRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  sharpeLike: number;
  avgRR: number;
  avgWinPct: number;
  avgLossPct: number;
  maxConsecutiveLosses: number;
  signalFrequencyPer1000: number;
  aPlus: { trades: number; winRate: number };
  aTier: { trades: number; winRate: number };
  lookAheadSafe: boolean;
}

export interface WalkForwardResult {
  train: BacktestResult;
  validation: BacktestResult;
  outOfSample: BacktestResult;
  overfitWarning: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Paper trading (src/paper.ts)
// ---------------------------------------------------------------------------

export interface PaperPosition {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  quantity: number;
  leverage: number;
  stopLoss: number;
  takeProfits: number[];
  openedAt: number;
  fees: number;
}

export interface PaperAccount {
  balance: number;
  equity: number;
  positions: PaperPosition[];
  realizedPnl: number;
  totalFees: number;
  totalFunding: number;
  tradeHistory: BacktestTrade[];
}
