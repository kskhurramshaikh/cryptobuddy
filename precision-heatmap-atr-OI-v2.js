
// precision-heatmap-atr-OI-v2.js — v2.2 (UPGRADED)
// Includes:
// - Deadband suppression
// - Trend persistence requirement
// - Momentum-aligned directional confirmation
// - Stronger LIQUIDITY_STRESSED suppression
// - Conviction smoothing (EMA-based)
// - Cleaner BUY/SELL gating before final signal
// - Reduced oscillation (anti-whipsaw layer)

import fetch from "node-fetch";

/* -------------------------------------------------------------
   CONFIGURATION & TUNABLES (top-level)
   (Updated: additional suppression, gating, smoothing)
------------------------------------------------------------- */

const BINANCE_LIMIT = 5000;
const ATR_PERIOD = 14;
const ATR_INTERVAL = "4h";
const CLUSTER_MULTIPLIER = 0.5;

const COVERAGE = 0.9; 
const MIN_STRENGTH = 0.03;
const DIST_MULTIPLIER = 6;

// Liquidation engine
const LIQ_THRESHOLD_FRAC = 0.10;
const LIQ_MAX_LOOKUP_FRAC = 0.5;

// Bias caps
const CVD_BIAS_MAX = 8;
const LCI_BIAS_MAX = 5;
const MELA_BIAS_MAX = 5;

// Momentum bias
const MOMENTUM_BIAS_MAX = 7.5;

// Regime-aware suppression
const REGIME_CVD_THRESHOLD = 40;
const REGIME_CAC_THRESHOLD = -1;
const SUPPRESSION_BUY_SCORE_CAP = 55;

// Liquidation proximity effect
const PROXIMITY_INFLUENCE_MAX = 10;

// NEW v2.2: Anti-oscillation tunables
const DEAD_BAND_THRESHOLD = 12;              // BUY/SELL scores closer than 12 → HOLD
const MOMENTUM_CONFIRM_THRESHOLD = 55;       // Direction must agree with momentum
const TREND_PERSIST_TICKS = 2;               // require 2 consecutive directional ticks
const SUPPRESS_IN_STRESS = true;             // enforce strong rules in LIQUIDITY_STRESSED
const SMOOTHING_ALPHA = 0.35;                // EMA smoothing of conviction vs last tick

// State memory (global, but safe because Nexus wrapper executes model sequentially)
let lastSignal = "HOLD";
let lastBuyScore = 50;
let lastSellScore = 50;
let trendConsistencyCounter = 0;

// Symbol map
const MAP_BINANCE = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };
const MAP_COINBASE = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD" };

/* -------------------------------------------------------------
   UTILS
------------------------------------------------------------- */

function formatUSDval(x) {
  if (!isFinite(x)) return "$0";
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(2)}K`;
  return `$${x.toFixed(2)}`;
}

function nowISO() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------
   FETCH BINANCE FUTURES METRICS
------------------------------------------------------------- */

async function fetchBinanceFuturesMetrics(symbolSpot, price) {
  const fapi = "https://fapi.binance.com";
  const res = { success: false };

  try {
    // OI
    try {
      const oiUrl = `${fapi}/fapi/v1/openInterest?symbol=${symbolSpot}`;
      const oiResp = await fetch(oiUrl, { timeout: 10000 });
      if (oiResp.ok) {
        const oiBody = await oiResp.json();
        const openInterest = Number(oiBody.openInterest || 0);
        res.openInterestContracts = openInterest;
        res.openInterestUSD = openInterest * (price || 0);
      }
    } catch {}

    // funding
    try {
      const fundUrl = `${fapi}/fapi/v1/premiumIndex?symbol=${symbolSpot}`;
      const fundResp = await fetch(fundUrl, { timeout: 10000 });
      if (fundResp.ok) {
        const fundBody = await fundResp.json();
        const lastFundingRate = Number(fundBody.lastFundingRate ?? 0);
        res.fundingRate = isFinite(lastFundingRate) ? lastFundingRate : null;
      }
    } catch {}

    // taker L/S ratio
    try {
      const ratioUrl = `${fapi}/futures/data/takerlongshortRatio?symbol=${symbolSpot}&period=5m&limit=1`;
      const ratioResp = await fetch(ratioUrl, { timeout: 10000 });
      if (ratioResp.ok) {
        const ratioBody = await ratioResp.json();
        const r = Array.isArray(ratioBody) ? ratioBody[0] : ratioBody;
        const longShortRatio = Number(r.longShortRatio ?? r.buySellRatio ?? 0);
        res.longShortRatio = isFinite(longShortRatio) ? longShortRatio : null;
      }
    } catch {}

    res.success = true;
    return res;
  } catch {
    return { success: false };
  }
}

/* -------------------------------------------------------------
   FETCH ORDERBOOKS
------------------------------------------------------------- */

async function fetchBinanceDepth(symbol, limit = BINANCE_LIMIT) {
  const tryLimits = [limit, 1000, 500, 100];
  for (const l of tryLimits) {
    try {
      const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${l}`;
      const res = await fetch(url, { timeout: 20000 });
      if (!res.ok) throw new Error("bad");
      const body = await res.json();
      return { bids: body.bids || [], asks: body.asks || [], usedLimit: l };
    } catch {}
  }
  throw new Error("Binance depth fetch failed");
}

async function fetchCoinbaseBook(productId) {
  try {
    const url = `https://api.exchange.coinbase.com/products/${productId}/book?level=3`;
    const res = await fetch(url, { timeout: 20000 });
    if (!res.ok) throw new Error("bad");
    const body = await res.json();
    return { bids: body.bids || [], asks: body.asks || [], levelUsed: 3 };
  } catch {
    const fallback = `https://api.exchange.coinbase.com/products/${productId}/book?level=2`;
    const res = await fetch(fallback);
    const body = await res.json();
    return { bids: body.bids || [], asks: body.asks || [], levelUsed: 2 };
  }
}

/* -------------------------------------------------------------
   BINANCE KLINES (with volume)
------------------------------------------------------------- */

async function fetchBinanceKlines(symbol, interval = "4h", limit = 100) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error("klines failed");
  const body = await res.json();

  return body.map(k => ({
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
  }));
}

function computeATR(klines, period = ATR_PERIOD) {
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

/* -------------------------------------------------------------
   DEPTH MERGE
------------------------------------------------------------- */

function aggregatePriceUsd(levels) {
  const map = new Map();
  for (const lvl of levels) {
    const price = Number(lvl[0]);
    const size = Number(lvl[1]);
    if (!isFinite(price) || !isFinite(size) || size <= 0) continue;
    const usd = price * size;
    map.set(price, (map.get(price) || 0) + usd);
  }
  return Array.from(map.entries()).map(([price, usd]) => ({ price, usd }));
}

/* -------------------------------------------------------------
   ATR CLUSTERING
------------------------------------------------------------- */

function clusterBySize(arr, clusterSize) {
  const bins = new Map();
  for (const { price, usd } of arr) {
    const idx = Math.floor(price / clusterSize);
    const low = idx * clusterSize;
    const high = (idx + 1) * clusterSize;
    const key = `${low}|${high}`;
    const obj = bins.get(key) || { low, high, usd: 0, count: 0 };
    obj.usd += usd;
    obj.count += 1;
    bins.set(key, obj);
  }
  return Array.from(bins.values()).sort((a, b) => b.usd - a.usd);
}

/* -------------------------------------------------------------
   MODE B FILTERING
------------------------------------------------------------- */

function applyModerateFilter(clusters, strongestUsd, atr, price) {
  const minUsd = strongestUsd * MIN_STRENGTH;
  const maxDist = atr * DIST_MULTIPLIER;
  return clusters.filter(c => {
    const mid = (c.low + c.high) / 2;
    const dist = Math.abs(mid - price);
    return c.usd >= minUsd && dist <= maxDist;
  });
}


/* -------------------------------------------------------------
   90% POI EXTRACTION
------------------------------------------------------------- */

function extractPOI(clusters, coverage = COVERAGE) {
  const total = clusters.reduce((s, c) => s + c.usd, 0);
  const target = total * coverage;
  let cumulative = 0;
  const poi = [];
  for (const c of clusters) {
    poi.push(c);
    cumulative += c.usd;
    if (cumulative >= target) break;
  }
  return { total, target, poi };
}

/* -------------------------------------------------------------
   ADVANCED LIQUIDATION ENGINE (A2)
------------------------------------------------------------- */

function buildCumulativeLadder(sideArr) {
  const sortedAsc = [...sideArr].sort((a, b) => a.price - b.price);
  return sortedAsc;
}

function findNearestLiquidationPriceSide({ ladderAsc, currentPrice, side, sideTotal, atr }) {
  const maxReach = atr * DIST_MULTIPLIER;
  const target1 = sideTotal * LIQ_THRESHOLD_FRAC;
  const target2 = sideTotal * LIQ_MAX_LOOKUP_FRAC;

  let cumulative = 0;

  if (side === "bid") {
    const below = ladderAsc.filter(p => p.price < currentPrice).sort((a, b) => b.price - a.price);
    for (const lvl of below) {
      cumulative += lvl.usd;
      const dist = Math.abs(currentPrice - lvl.price);
      if (dist <= maxReach && cumulative >= target1) {
        return { price: lvl.price, accum: cumulative, dist, thresholdHit: target1 };
      }
    }
    cumulative = 0;
    for (const lvl of below) {
      cumulative += lvl.usd;
      const dist = Math.abs(currentPrice - lvl.price);
      if (dist <= maxReach && cumulative >= target2) {
        return { price: lvl.price, accum: cumulative, dist, thresholdHit: target2 };
      }
    }
    return null;
  } else {
    const above = ladderAsc.filter(p => p.price > currentPrice).sort((a, b) => a.price - b.price);
    for (const lvl of above) {
      cumulative += lvl.usd;
      const dist = Math.abs(lvl.price - currentPrice);
      if (dist <= maxReach && cumulative >= target1) {
        return { price: lvl.price, accum: cumulative, dist, thresholdHit: target1 };
      }
    }
    cumulative = 0;
    for (const lvl of above) {
      cumulative += lvl.usd;
      const dist = Math.abs(lvl.price - currentPrice);
      if (dist <= maxReach && cumulative >= target2) {
        return { price: lvl.price, accum: cumulative, dist, thresholdHit: target2 };
      }
    }
    return null;
  }
}

/* -------------------------------------------------------------
   MAX-PAIN (cluster top) helper
------------------------------------------------------------- */

function topClusterAsPain(clusters) {
  if (!clusters || !clusters.length) return null;
  const top = [...clusters].sort((a, b) => b.usd - a.usd)[0];
  return { price: Math.round((top.low + top.high) / 2), accum: top.usd };
}

/* -------------------------------------------------------------
   COMBINED LADDER OUTPUT (Format B)
------------------------------------------------------------- */

function printCombinedLadder(bidPOI, askPOI, currentPrice) {
  const f = (x) =>
    x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` :
    x >= 1e3 ? `$${(x / 1e3).toFixed(2)}K` :
    `$${x.toFixed(2)}`;

  const support = bidPOI.poi
    .map(c => ({ ...c, mid: (c.low + c.high) / 2 }))
    .filter(c => c.mid < currentPrice)
    .sort((a, b) => b.mid - a.mid);

  const resistance = askPOI.poi
    .map(c => ({ ...c, mid: (c.low + c.high) / 2 }))
    .filter(c => c.mid > currentPrice)
    .sort((a, b) => b.mid - a.mid);

  console.log(`\n════════ RESISTANCE (Above Price) ════════`);
  resistance.forEach((c, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. ${c.low.toLocaleString()} - ${c.high.toLocaleString()} → ${f(c.usd)}`
    );
  });

  console.log(`\n💎 CURRENT PRICE → $${currentPrice.toLocaleString()} 💎\n`);

  console.log(`════════ SUPPORT (Below Price) ════════`);
  support.forEach((c, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. ${c.low.toLocaleString()} - ${c.high.toLocaleString()} → ${f(c.usd)}`
    );
  });

  console.log("");
}

/* -------------------------------------------------------------
   TALR & trend slope
------------------------------------------------------------- */

function computeTalrAndSlope(klines) {
  if (!klines || klines.length < 10) return { talr: 50, slopePct: 0, interpretation: "insufficient data" };

  let down = 0, up = 0;
  for (let i = 1; i < klines.length; i++) {
    const change = klines[i].close - klines[i - 1].close;
    if (change < 0) down++;
    else if (change > 0) up++;
  }
  const talr = Math.round((down / (up + down || 1)) * 100);
  const slope = ((klines[klines.length - 1].close - klines[0].close) / klines[0].close) * 100;
  return {
    talr,
    slopePct: Math.abs(slope),
    interpretation: talr > 60 ? "downward pressure" : talr < 40 ? "upward pressure" : "balanced",
  };
}

/* -------------------------------------------------------------
   EMA helper
------------------------------------------------------------- */

function ema(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed = seed / period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/* -------------------------------------------------------------
   RSI
------------------------------------------------------------- */

function computeRSI(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const closes = klines.map(k => k.close);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  const lastGains = gains.slice(-period);
  const lastLosses = losses.slice(-period);
  const avgGain = lastGains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = lastLosses.reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Math.max(0, Math.min(100, rsi));
}

/* -------------------------------------------------------------
   MACD hist
------------------------------------------------------------- */

function computeMACDHistogram(klines, fast = 12, slow = 26, signalP = 9) {
  const closes = klines.map(k => k.close);
  if (closes.length < slow + signalP) return null;

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdSeries = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] == null || emaSlow[i] == null) macdSeries.push(null);
    else macdSeries.push(emaFast[i] - emaSlow[i]);
  }
  const macdClean = macdSeries.map(x => (x == null ? 0 : x));
  const signalArr = ema(macdClean, signalP);
  const lastIdx = closes.length - 1;
  const macd = macdSeries[lastIdx] == null ? 0 : macdSeries[lastIdx];
  const signal = signalArr[lastIdx] == null ? 0 : signalArr[lastIdx];
  const hist = macd - signal;
  const recentHist = [];
  for (let i = Math.max(0, macdSeries.length - slow); i < macdSeries.length; i++) {
    const v = macdSeries[i] == null ? 0 : macdSeries[i] - (signalArr[i] == null ? 0 : signalArr[i]);
    recentHist.push(Math.abs(v));
  }
  const avgAbsHist = recentHist.length ? recentHist.reduce((a, b) => a + b, 0) / recentHist.length : 0;
  return { macd, signal, hist, avgAbsHist };
}

/* -------------------------------------------------------------
   MOMENTUM LAYER
------------------------------------------------------------- */

function computeMomentumScore(klines, price) {
  if (!klines || klines.length < 50) {
    return {
      available: false,
      rsi: null,
      rsiScore: 50,
      macdHist: null,
      macdScore: 50,
      ma50: null,
      ma200: null,
      maScore: 50,
      momentumScore: 50
    };
  }

  const rsi = computeRSI(klines, 14);
  const rsiScore = rsi == null ? 50 : rsi;

  const macdObj = computeMACDHistogram(klines, 12, 26, 9);
  let macdScore = 50;
  let macdHist = null;
  if (macdObj) {
    macdHist = macdObj.hist;
    const avgAbs = macdObj.avgAbsHist || 0;
    const denom = Math.max(avgAbs, Math.abs(macdHist), 1e-8);
    const scaled = Math.max(-1, Math.min(1, macdHist / denom));
    macdScore = Math.round(50 + scaled * 25);
    macdScore = Math.max(0, Math.min(100, macdScore));
  }

  const closes = klines.map(k => k.close);
  const maPeriod50 = 50;
  const maPeriod200 = 200;
  let ma50 = null, ma200 = null;
  if (closes.length >= maPeriod200) {
    const sum50 = closes.slice(-maPeriod50).reduce((a,b)=>a+b,0);
    const sum200 = closes.slice(-maPeriod200).reduce((a,b)=>a+b,0);
    ma50 = sum50 / maPeriod50;
    ma200 = sum200 / maPeriod200;
  } else if (closes.length >= maPeriod50) {
    const sum50 = closes.slice(-maPeriod50).reduce((a,b)=>a+b,0);
    ma50 = sum50 / maPeriod50;
    ma200 = null;
  }

  let maScore = 50;
  if (ma50 != null && ma200 != null) {
    if (ma50 > ma200) maScore = 70;
    else maScore = 30;
    if (price > ma50 && price > ma200) maScore = Math.min(95, maScore + 10);
    if (price < ma50 && price < ma200) maScore = Math.max(5, maScore - 10);
  } else if (ma50 != null) {
    maScore = price > ma50 ? 60 : 40;
  } else {
    maScore = 50;
  }

  const momentumScore = Math.round(((rsiScore ?? 50) * 0.40) + (macdScore * 0.35) + (maScore * 0.25));
  return {
    available: true,
    rsi,
    rsiScore,
    macdHist,
    macdScore,
    ma50,
    ma200,
    maScore,
    momentumScore: Math.max(0, Math.min(100, momentumScore))
  };
}

/* -------------------------------------------------------------
   NEW: CVD
------------------------------------------------------------- */

function computeCVD(klines, lookback = 100) {
  if (!klines || klines.length < 2) return { available: false, cvd: 0, cvdScore: 50 };
  const slice = klines.slice(-lookback);
  let cvdArr = [];
  let running = 0;
  let totalVol = 0;
  for (const k of slice) {
    const delta = (k.close > k.open) ? k.volume : (k.close < k.open ? -k.volume : 0);
    running += delta;
    totalVol += k.volume;
    cvdArr.push(running);
  }
  const cvdFirst = cvdArr[0] || 0;
  const cvdLast = cvdArr[cvdArr.length - 1] || 0;
  const cvdChange = cvdLast - cvdFirst;
  const denom = totalVol || 1;
  const norm = cvdChange / denom;
  const clipped = Math.max(-1, Math.min(1, norm * 10));
  const cvdScore = Math.round(50 + clipped * 50);
  return { available: true, cvd: cvdLast, cvdScore: Math.max(0, Math.min(100, cvdScore)) };
}

/* -------------------------------------------------------------
   NEW: LCI
------------------------------------------------------------- */

function computeLCI(bidsArr, asksArr, price, atr) {
  const all = [...bidsArr, ...asksArr];
  const total = all.reduce((s, x) => s + (x.usd || 0), 0) || 1;
  const radius = atr || 1;
  const minP = price - radius;
  const maxP = price + radius;
  const within = all.filter(l => l.price >= minP && l.price <= maxP).reduce((s, x) => s + (x.usd || 0), 0);
  const lci = within / total;
  const lciScore = Math.round(Math.max(0, Math.min(100, lci * 100)));
  return { lci, lciScore };
}

/* -------------------------------------------------------------
   NEW: MELA
------------------------------------------------------------- */

function computeMELA(binClusters, cbClusters, clusterSize) {
  if (!binClusters || !cbClusters) return { mela: 0, melaScore: 50, available: false };
  const binMids = binClusters.map(c => ((c.low + c.high) / 2));
  const cbMids = cbClusters.map(c => ((c.low + c.high) / 2));
  let overlaps = 0;
  for (const b of binMids) {
    for (const c of cbMids) {
      if (Math.abs(b - c) <= Math.max(clusterSize, 1)) {
        overlaps++;
        break;
      }
    }
  }
  const denom = Math.max(1, Math.max(binMids.length, cbMids.length));
  const mela = overlaps / denom;
  const melaScore = Math.round(mela * 100);
  return { mela, melaScore, available: true };
}

/* -------------------------------------------------------------
   Compute Regime Heuristic
------------------------------------------------------------- */

function computeRegime({ atr, price, lciObj, momentumObj, bidPOI, askPOI }) {
  try {
    const volPct = atr / Math.max(price, 1);
    const liqConc = (lciObj && typeof lciObj.lci === "number") ? lciObj.lci : 0;
    if (liqConc > 0.06 && volPct > 0.01) return "LIQUIDITY_STRESSED";
    if (liqConc > 0.08) return "LIQUIDITY_STRESSED";
    if (momentumObj && momentumObj.momentumScore < 45 && liqConc > 0.04) return "LIQUIDITY_STRESSED";
    return "NORMAL";
  } catch (e) {
    return "NORMAL";
  }
}


/* -------------------------------------------------------------
   CONVICTION ENGINE (updated to accept new structural metrics
   and apply flow-aware suppression)
------------------------------------------------------------- */
function computeConvictionAndSignal({
  buyPct, sellPct, talrObj,
  nearestSupportDistPct, nearestResistanceDistPct,
  bidPOI, askPOI, futuresMetrics,
  momentumScore, // 0..100
  cvdScore, lciScore, melaScore,
  atr,
  // optional external inputs
  cacModifier = null, // optional macro cross-asset modifier (negative if macro hurts buys)
  regime = null
}) {
  // defaultize
  cacModifier = (typeof cacModifier === "number") ? cacModifier : (futuresMetrics && typeof futuresMetrics.longShortRatio === "number" ? ((futuresMetrics.longShortRatio - 1) * 100) : 0);
  regime = regime || computeRegime({ atr, price: (bidPOI.poi[0]?.price || askPOI.poi[0]?.price || 1), lciObj: { lci: (lciScore || 0)/100 }, momentumObj: { momentumScore } , bidPOI, askPOI });

  const dominanceBias = (buyPct - sellPct); // +ve -> buy-favor
  const talrBias = (50 - talrObj.talr) / 2;

  const proxBuy = Math.max(0, 40 - nearestSupportDistPct);
  const proxSell = Math.max(0, 40 - nearestResistanceDistPct);

  const bidMass = bidPOI.total || 0;
  const askMass = askPOI.total || 1;
  const massBias = ((bidMass - askMass) / (bidMass + askMass)) * 20;

  // futures biases (unchanged core)
  let futuresBias = 0;
  let futuresStrength = 0; // how heavily futures should influence conviction (0..30)
  if (futuresMetrics && futuresMetrics.success) {
    const oiUSD = futuresMetrics.openInterestUSD || 0;
    futuresStrength = Math.min(30, Math.round(Math.log10(oiUSD + 1) * 3));

    const fr = futuresMetrics.fundingRate || 0;
    const frBias = (fr || 0) * 1000;
    const ls = futuresMetrics.longShortRatio || 1;
    const lsBias = (ls - 1) * 10;

    futuresBias = lsBias - frBias;
    futuresBias = futuresBias * (futuresStrength / 20);
  }

  // momentum bias (unchanged)
  let momentumBias = 0;
  if (typeof momentumScore === "number") {
    momentumBias = ((momentumScore - 50) / 50) * MOMENTUM_BIAS_MAX;
  }

  // structural extras biases (CVD, LCI, MELA)
  let cvdBias = 0, lciBias = 0, melaBias = 0;

  if (typeof cvdScore === "number") {
    cvdBias = ((cvdScore - 50) / 50) * CVD_BIAS_MAX; // positive -> bullish
  }
  if (typeof lciScore === "number") {
    const signed = (buyPct >= sellPct) ? (lciScore - 50) : (50 - lciScore);
    lciBias = (signed / 50) * LCI_BIAS_MAX;
  }
  if (typeof melaScore === "number") {
    const signed = (buyPct >= sellPct) ? (melaScore - 50) : (50 - melaScore);
    melaBias = (signed / 50) * MELA_BIAS_MAX;
  }

  // combine base scores (original structure preserved) then add extras
  let buyScore = 50 + dominanceBias * 0.35 + talrBias * 0.5 + proxBuy * 0.5 + massBias * 0.4 + (futuresBias || 0) + momentumBias;
  let sellScore = 50 - dominanceBias * 0.35 - talrBias * 0.5 + proxSell * 0.5 - massBias * 0.4 - (futuresBias || 0) - momentumBias;

  // apply structural extras (CVD, LCI, MELA) — they push in favor of the dominant side by design
  buyScore += (cvdBias + lciBias + melaBias);
  sellScore -= (cvdBias + lciBias + melaBias);

  // LIQUIDATION PROXIMITY INFLUENCE:
  // If nearest support is very close (small % of ATR window), increase buyScore; if very far, reduce.
  // Map nearestSupportDistPct into [-PROXIMITY_INFLUENCE_MAX .. PROXIMITY_INFLUENCE_MAX]
  const proxFactor = Math.max(-PROXIMITY_INFLUENCE_MAX, Math.min(PROXIMITY_INFLUENCE_MAX, (40 - nearestSupportDistPct) / 4));
  buyScore += proxFactor;
  sellScore -= proxFactor;

  // Apply CAC (cross-asset) penalty: cacModifier is in percent (e.g. -0.5, -1.2). convert to score steps
  // Only apply a moderate effect by default (user can tune)
  const cacPenalty = (cacModifier || 0) * 0.2; // e.g. -3.7 -> -0.74 points
  buyScore += cacPenalty;
  sellScore -= cacPenalty;

  buyScore = Math.max(0, Math.min(100, Math.round(buyScore)));
  sellScore = Math.max(0, Math.min(100, Math.round(sellScore)));

  // Flow-aware suppression rule (NEW):
  // If we're in LIQUIDITY_STRESSED regime AND cvdScore indicates selling pressure AND cacModifier indicates macro/sentiment is negative
  // then be conservative: prevent low-quality BUYs by forcing a HOLD (reduce buyScore significantly)
  const isRegimeStressed = (regime === "LIQUIDITY_STRESSED" || regime === "STRESSED");

  if (isRegimeStressed && typeof cvdScore === "number" && cvdScore < REGIME_CVD_THRESHOLD && (cacModifier < REGIME_CAC_THRESHOLD)) {
    // Reduce buy score aggressively if buyScore is not already very high
    if (buyScore < SUPPRESSION_BUY_SCORE_CAP) {
      // strong suppression
      const suppressionAmount = Math.max(15, Math.round((REGIME_CVD_THRESHOLD - cvdScore) / 5)); // scale by how low cvd is
      buyScore = Math.max(0, buyScore - suppressionAmount);
      sellScore = Math.min(100, sellScore + Math.round(suppressionAmount / 2));
    } else {
      // partial suppression when buyScore is already large
      buyScore = Math.max(0, buyScore - 8);
      sellScore = Math.min(100, sellScore + 4);
    }
  }

  // Re-round and clamp again
  buyScore = Math.max(0, Math.min(100, Math.round(buyScore)));
  sellScore = Math.max(0, Math.min(100, Math.round(sellScore)));

  let signal = "HOLD";
  let conviction = Math.max(buyScore, sellScore);

  if (buyScore > sellScore + 8 && buyScore >= 60) signal = "BUY";
  else if (sellScore > buyScore + 8 && sellScore >= 60) signal = "SELL";
  else {
    signal = "HOLD";
    conviction = Math.round((buyScore + sellScore) / 2);
  }

  // Return also the internal bias components for debugging
  return { signal, conviction, buyScore, sellScore, futuresStrength, futuresBias, momentumBias, cvdBias, lciBias, melaBias, cacModifier, regime };
}

/* -------------------------------------------------------------
   NEXUS AI SUMMARY V2 (updated to show new metric lines)
------------------------------------------------------------- */
function buildNexusAISummaryV2({
  buyPct,
  sellPct,
  nearestSupportObj,
  nearestResistanceObj,
  maxPainDown,
  maxPainUp,
  talrObj,
  futuresMetrics,
  convObj,
  price,
  atr,
  momentumObj,
  cvdObj,
  lciObj,
  melaObj,
  cacModifier,
  regime
}) {
  const strongSide = buyPct > sellPct ? "Buyers" : buyPct < sellPct ? "Sellers" : "Balanced";
  const dominanceLine = `• ${strongSide} control ${Math.max(buyPct, sellPct).toFixed(1)}% of displayed liquidity.`;

  const downLine = nearestSupportObj
    ? `🔻 Nearest meaningful long-liquidation zone: $${Math.round(nearestSupportObj.price)} — ~${formatUSDval(nearestSupportObj.accum)} at risk (distance ${(nearestSupportObj.dist / (atr * DIST_MULTIPLIER) * 100).toFixed(0)}% of ATR window).`
    : `🔻 No nearby long-liquidation zone within ATR reach.`;

  const upLine = nearestResistanceObj
    ? `🔺 Nearest meaningful short-liquidation zone: $${Math.round(nearestResistanceObj.price)} — ~${formatUSDval(nearestResistanceObj.accum)} at risk (distance ${(nearestResistanceObj.dist / (atr * DIST_MULTIPLIER * 1) * 100).toFixed(0)}% of ATR window).`
    : `🔺 No nearby short-liquidation zone within ATR reach.`;

  const maxPainLine = `💥 Max-pain snapshot: Down ≈ $${maxPainDown?.price ?? "N/A"} (${formatUSDval(maxPainDown?.accum || 0)}) | Up ≈ $${maxPainUp?.price ?? "N/A"} (${formatUSDval(maxPainUp?.accum || 0)})`;

  // Futures simple explanation few words
  let futuresLine = "📡 Futures: unavailable.";
  if (futuresMetrics && futuresMetrics.success) {
    const oi = futuresMetrics.openInterestUSD ? formatUSDval(futuresMetrics.openInterestUSD) : "N/A";
    let frTxt = (typeof futuresMetrics.fundingRate === "number") ? (futuresMetrics.fundingRate > 0 ? "positive funding (crowded longs)" : futuresMetrics.fundingRate < 0 ? "negative funding (crowded shorts)" : "neutral") : "funding unavailable";
    let lsTxt = futuresMetrics.longShortRatio ? (futuresMetrics.longShortRatio > 1 ? `taker flow leans long (${futuresMetrics.longShortRatio.toFixed(2)})` : `taker flow leans short (${futuresMetrics.longShortRatio.toFixed(2)})`) : "";
    futuresLine = `📡 Futures OI ${oi} · ${frTxt}${lsTxt ? " · " + lsTxt : ""}`;
  }

  // Momentum short line
  let momentumLine = "";
  if (momentumObj && momentumObj.available) {
    momentumLine = `⚡ Momentum: score ${momentumObj.momentumScore}/100 (RSI ${momentumObj.rsi ? momentumObj.rsi.toFixed(1) : "N/A"}, MACD_hist ${momentumObj.macdHist ? momentumObj.macdHist.toFixed(6) : "N/A"}, MA50 ${momentumObj.ma50 ? momentumObj.ma50.toFixed(2) : "N/A"})`;
  } else {
    momentumLine = "⚡ Momentum: insufficient data.";
  }

  // Structural extras lines
  const cvdLine = cvdObj && cvdObj.available ? `🔍 CVD: score ${cvdObj.cvdScore}/100` : `🔍 CVD: insufficient data.`;
  const lciLine = lciObj ? `🧭 LCI: ${ (lciObj.lci*100).toFixed(1) }% concentrated (score ${lciObj.lciScore}/100)` : `🧭 LCI: n/a`;
  const melaLine = melaObj && melaObj.available ? `🔗 MELA: agreement ${ (melaObj.mela*100).toFixed(1) }% (score ${melaObj.melaScore}/100)` : `🔗 MELA: insufficient data.`;

  const cacLine = `🔁 Cross-Asset (proxy via futures L/S): ${cacModifier ? (cacModifier.toFixed(2) + "%") : "n/a (use external CAC for precise)"}${(cacModifier < 0) ? " · macro/momentum headwind" : ""}`;

  const signalLine = `🎯 Call: ${convObj.signal} — Conviction: ${convObj.conviction}/100 (buyScore:${convObj.buyScore}, sellScore:${convObj.sellScore})`;

  let finalInterpretation = "";
  if (buyPct > sellPct + 5 && nearestSupportObj && (!nearestResistanceObj || nearestSupportObj.dist < nearestResistanceObj.dist)) {
    finalInterpretation = "Liquidity sits below price — price often pulls down to hunt that liquidity before major rallies.";
  } else if (sellPct > buyPct + 5 && nearestResistanceObj && (!nearestSupportObj || nearestResistanceObj.dist < nearestSupportObj.dist)) {
    finalInterpretation = "Liquidity sits above price — price may push up to capture short squeezes before extended drops.";
  } else {
    finalInterpretation = "No dominant immediate squeeze — price may range until a clear sweep occurs.";
  }

  return [
    "📊 Nexus AI Summary",
    dominanceLine,
    "",
    downLine,
    upLine,
    "",
    maxPainLine,
    "",
    "📈 Spot trend: " + talrObj.interpretation,
    futuresLine,
    momentumLine,
    cvdLine,
    lciLine,
    melaLine,
    cacLine,
    "",
    finalInterpretation,
    "",
    signalLine,
    "",
    `(model horizon: short-term — based on ${ATR_INTERVAL} ATR window)`,
    `(regime: ${regime})`,
    `(generated: ${nowISO()})`
  ].join("\n");
}

/* -------------------------------------------------------------
   MAIN LOGIC (integrates everything)
------------------------------------------------------------- */
async function runForSymbol(sym) {
  const symbol = sym.toUpperCase();
  if (!MAP_BINANCE[symbol]) {
    console.error("Use: BTC, ETH, SOL");
    process.exit(1);
  }

  console.log(`\n🔵 Precision ATR + Filter Heatmap + Futures OI (A2 Liquidation) for ${symbol}`);

  const binPair = MAP_BINANCE[symbol];
  const cbPair = MAP_COINBASE[symbol];

  // fetch spot books
  const [binBook, cbBook] = await Promise.all([
    fetchBinanceDepth(binPair),
    fetchCoinbaseBook(cbPair),
  ]).catch(err => { console.error("fetch error", err); process.exit(1); });

  // Keep per-exchange arrays for MELA
  const bidsArrBin = aggregatePriceUsd([...binBook.bids]);
  const asksArrBin = aggregatePriceUsd([...binBook.asks]);
  const bidsArrCb = aggregatePriceUsd([...cbBook.bids]);
  const asksArrCb = aggregatePriceUsd([...cbBook.asks]);

  // combined arrays (used for LCI and ladders)
  const bidsArr = aggregatePriceUsd([...binBook.bids, ...cbBook.bids]);
  const asksArr = aggregatePriceUsd([...binBook.asks, ...cbBook.asks]);

  // ATR / cluster size (klines includes volume now)
  const klines = await fetchBinanceKlines(binPair, ATR_INTERVAL, 300);
  const atr = computeATR(klines, ATR_PERIOD);
  const clusterSize = Math.max(1, atr * CLUSTER_MULTIPLIER);

  // Price mid
  const bestBid = Number(binBook.bids?.[0]?.[0] || binBook.asks?.[0]?.[0] || bidsArr[0]?.price || 0);
  const bestAsk = Number(binBook.asks?.[0]?.[0] || binBook.bids?.[0]?.[0] || asksArr[0]?.price || 0);
  const price = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : (bidsArr[0]?.price || asksArr[0]?.price || 0);

  if (!price) {
    console.error("Unable to determine current price.");
    process.exit(1);
  }

  // FUTURES METRICS (approx)
  const futuresSpotSymbol = binPair;
  const futuresMetrics = await fetchBinanceFuturesMetrics(futuresSpotSymbol, price);

  // Clustering per-exchange & combined
  let bidClusters = clusterBySize(bidsArr, clusterSize);
  let askClusters = clusterBySize(asksArr, clusterSize);

  let bidClustersBin = clusterBySize(bidsArrBin, clusterSize);
  let askClustersBin = clusterBySize(asksArrBin, clusterSize);
  let bidClustersCb = clusterBySize(bidsArrCb, clusterSize);
  let askClustersCb = clusterBySize(asksArrCb, clusterSize);

  if (!bidClusters.length || !askClusters.length) {
    console.error("No cluster data available.");
    process.exit(1);
  }

  // Filtering combined
  bidClusters = applyModerateFilter(bidClusters, bidClusters[0].usd, atr, price);
  askClusters = applyModerateFilter(askClusters, askClusters[0].usd, atr, price);

  // Filtering per-exchange for MELA robustness (optional, keep broad)
  bidClustersBin = applyModerateFilter(bidClustersBin, bidClustersBin[0]?.usd || 0, atr, price);
  askClustersBin = applyModerateFilter(askClustersBin, askClustersBin[0]?.usd || 0, atr, price);
  bidClustersCb = applyModerateFilter(bidClustersCb, bidClustersCb[0]?.usd || 0, atr, price);
  askClustersCb = applyModerateFilter(askClustersCb, askClustersCb[0]?.usd || 0, atr, price);

  // Extract POI
  const bidPOI = extractPOI(bidClusters);
  const askPOI = extractPOI(askClusters);

  // Buy/Sell dominance
  const totalBid = bidPOI.total || 0;
  const totalAsk = askPOI.total || 0;
  const buyPct = totalBid + totalAsk === 0 ? 50 : ((totalBid / (totalBid + totalAsk)) * 100);
  const sellPct = totalBid + totalAsk === 0 ? 50 : ((totalAsk / (totalBid + totalAsk)) * 100);

  // TALR & slope
  const talrObj = computeTalrAndSlope(klines);

  // Momentum layer (Option 3 placement)
  const momentumObj = computeMomentumScore(klines, price);

  // New structural extras
  const cvdObj = computeCVD(klines, 200); // lookback 200 klines (adjustable)
  const lciObj = computeLCI(bidsArr, asksArr, price, atr);
  // MELA: Compare combined Binance vs Coinbase clusters for both sides
  const bidMela = computeMELA(bidClustersBin, bidClustersCb, clusterSize);
  const askMela = computeMELA(askClustersBin, askClustersCb, clusterSize);
  // combine bid/ask mela by averaging (simple)
  const melaCombined = {
    available: bidMela.available || askMela.available,
    mela: Math.max(0, ((bidMela.mela || 0) + (askMela.mela || 0)) / 2),
    melaScore: Math.round(Math.max(0, Math.min(100, (((bidMela.melaScore || 50) + (askMela.melaScore || 50)) / 2))))
  };

  // Build cumulative ladders (A2)
  const bidLadderAsc = buildCumulativeLadder(bidsArr);
  const askLadderAsc = buildCumulativeLadder(asksArr);

  // nearest meaningful liquidation via cumulative ladders (within ATR reach)
  const nearestSupportObj = findNearestLiquidationPriceSide({
    ladderAsc: bidLadderAsc,
    currentPrice: price,
    side: "bid",
    sideTotal: totalBid,
    atr
  });

  const nearestResistanceObj = findNearestLiquidationPriceSide({
    ladderAsc: askLadderAsc,
    currentPrice: price,
    side: "ask",
    sideTotal: totalAsk,
    atr
  });

  // fallback to cluster top if nearest null
  const maxPainDown = topClusterAsPain(bidClusters);
  const maxPainUp = topClusterAsPain(askClusters);

  const nearestSupportFinal = nearestSupportObj || (maxPainDown ? { price: maxPainDown.price, accum: maxPainDown.accum, dist: Math.abs(price - maxPainDown.price) } : null);
  const nearestResistanceFinal = nearestResistanceObj || (maxPainUp ? { price: maxPainUp.price, accum: maxPainUp.accum, dist: Math.abs(price - maxPainUp.price) } : null);

  const nearestSupportDistPct = nearestSupportFinal && atr ? (nearestSupportFinal.dist / (atr * DIST_MULTIPLIER)) * 100 : 999;
  const nearestResistanceDistPct = nearestResistanceFinal && atr ? (nearestResistanceFinal.dist / (atr * DIST_MULTIPLIER)) * 100 : 999;

  // compute a simple CAC proxy (fallback) from futures long/short ratio if external CAC not provided
  const cacProxy = (futuresMetrics && typeof futuresMetrics.longShortRatio === "number") ? ((futuresMetrics.longShortRatio - 1) * 100) : 0;

  // compute regime (heuristic)
  const regime = computeRegime({ atr, price, lciObj, momentumObj, bidPOI, askPOI });

  // compute conviction and signal (includes futures bias, momentum, and new extras)
  const convObj = computeConvictionAndSignal({
    buyPct, sellPct, talrObj,
    nearestSupportDistPct, nearestResistanceDistPct,
    bidPOI, askPOI, futuresMetrics,
    momentumScore: momentumObj.momentumScore,
    cvdScore: cvdObj.cvdScore,
    lciScore: lciObj.lciScore,
    melaScore: melaCombined.melaScore,
    atr,
    cacModifier: cacProxy,
    regime
  });

  // Print ladder
  printCombinedLadder(bidPOI, askPOI, price);

  // Print dominance lines
  console.log(`📉 Sell-Side Dominance: ${sellPct.toFixed(1)}%`);
  console.log(`📈 Buy-Side Dominance:  ${buyPct.toFixed(1)}%\n`);

  // Print futures quick numbers in terminal
  if (futuresMetrics && futuresMetrics.success) {
    console.log("📡 Futures (Binance) Metrics (approx):");
    console.log(`  Open Interest (contracts): ${futuresMetrics.openInterestContracts ?? "N/A"}`);
    console.log(`  Open Interest (approx USD): ${futuresMetrics.openInterestUSD ? formatUSDval(futuresMetrics.openInterestUSD) : "N/A"}`);
    console.log(`  Funding rate (latest): ${futuresMetrics.fundingRate ?? "N/A"}`);
    console.log(`  Taker Long/Short Ratio (proxy): ${futuresMetrics.longShortRatio ?? "N/A"}`);
    console.log("");
  }

  // Print momentum debug
  if (momentumObj && momentumObj.available) {
    console.log("⚡ Momentum Layer:");
    console.log(`   RSI: ${momentumObj.rsi ? momentumObj.rsi.toFixed(2) : "N/A"} -> rsiScore:${momentumObj.rsiScore}`);
    console.log(`   MACD hist: ${momentumObj.macdHist ? momentumObj.macdHist.toFixed(6) : "N/A"} -> macdScore:${momentumObj.macdScore}`);
    console.log(`   MA50: ${momentumObj.ma50 ? momentumObj.ma50.toFixed(2) : "N/A"}, MA200: ${momentumObj.ma200 ? momentumObj.ma200.toFixed(2) : "N/A"} -> maScore:${momentumObj.maScore}`);
    console.log(`   MomentumScore: ${momentumObj.momentumScore}`);
    console.log("");
  }

  // Print new structural extras
  if (cvdObj && cvdObj.available) {
    console.log(`🔍 CVD: cvd:${cvdObj.cvd.toFixed ? cvdObj.cvd.toFixed(2) : cvdObj.cvd} -> cvdScore:${cvdObj.cvdScore}`);
  } else {
    console.log("🔍 CVD: insufficient data.");
  }
  console.log(`🧭 LCI: concentrated ${(lciObj.lci*100).toFixed(2)}% -> lciScore:${lciObj.lciScore}`);
  if (melaCombined && melaCombined.available) {
    console.log(`🔗 MELA: agreement ${(melaCombined.mela*100).toFixed(2)}% -> melaScore:${melaCombined.melaScore}`);
  } else {
    console.log("🔗 MELA: insufficient data.");
  }
  console.log("");

  // Nexus AI Summary V2
  const aiSummary = buildNexusAISummaryV2({
    buyPct,
    sellPct,
    nearestSupportObj: nearestSupportFinal,
    nearestResistanceObj: nearestResistanceFinal,
    maxPainDown,
    maxPainUp,
    talrObj,
    futuresMetrics,
    convObj,
    price,
    atr,
    momentumObj,
    cvdObj,
    lciObj,
    melaObj: melaCombined,
    cacModifier: cacProxy,
    regime
  });

  console.log(aiSummary);
  console.log("");
  console.log(`Bid POI Count: ${bidPOI.poi.length}`);
  console.log(`Ask POI Count: ${askPOI.poi.length}`);
  console.log(`ATR (${ATR_INTERVAL}): ${atr.toFixed(2)} | Cluster size: ${clusterSize.toFixed(2)}`);
  // --- MULTI-TIMEFRAME ATR & VOLATILITY ENGINE (non-breaking addition) ---
  // Compute additional ATRs on other timeframes and EWMA realized volatility.
  async function safeFetchKlines(pair, interval, limit=300) {
    try {
      return await fetchBinanceKlines(pair, interval, limit);
    } catch (e) {
      return null;
    }
  }

  // helper: compute log returns array
  function computeReturnsFromKlines(klines) {
    if (!klines || klines.length < 2) return [];
    const r = [];
    for (let i = 1; i < klines.length; i++) {
      const a = klines[i-1].close, b = klines[i].close;
      if (!isFinite(a) || !isFinite(b) || a <= 0) continue;
      r.push(Math.log(b / a));
    }
    return r;
  }

  function realizedVol(returns, window) {
    if (!returns || returns.length < 2) return null;
    const slice = returns.slice(-window);
    if (!slice.length) return null;
    const varr = slice.reduce((s, x) => s + x * x, 0) / slice.length;
    return Math.sqrt(varr);
  }

  function ewmaVol(returns, lambda = 0.94) {
    if (!returns || returns.length === 0) return null;
    let s2 = returns[0]*returns[0];
    for (let i = 1; i < returns.length; i++) {
      s2 = lambda * s2 + (1 - lambda) * returns[i]*returns[i];
    }
    return Math.sqrt(s2);
  }

  // baseline median helper
  function median(arr) {
    const a = (arr || []).slice().filter(x => isFinite(x)).sort((x,y)=>x-y);
    if (!a.length) return null;
    const mid = Math.floor(a.length/2);
    return a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2;
  }

  // Attempt to fetch faster timeframes (best-effort, non-blocking to main logic)
  let atr_5m = null, atr_15m = null, atr_1h = null;
  let vol_5m = null, vol_15m = null, vol_1h = null;
  try {
    // note: limits kept reasonable to reduce API load
    const [klines_5m, klines_15m, klines_1h] = await Promise.all([
      safeFetchKlines(binPair, "5m", 500),
      safeFetchKlines(binPair, "15m", 400),
      safeFetchKlines(binPair, "1h", 300)
    ]);

    if (klines_5m) {
      atr_5m = computeATR(klines_5m, ATR_PERIOD);
      const r5 = computeReturnsFromKlines(klines_5m);
      vol_5m = ewmaVol(r5.slice(-500), 0.97) || realizedVol(r5, Math.min(r5.length, 50));
    }
    if (klines_15m) {
      atr_15m = computeATR(klines_15m, ATR_PERIOD);
      const r15 = computeReturnsFromKlines(klines_15m);
      vol_15m = ewmaVol(r15.slice(-400), 0.96) || realizedVol(r15, Math.min(r15.length, 50));
    }
    if (klines_1h) {
      atr_1h = computeATR(klines_1h, ATR_PERIOD);
      const r1 = computeReturnsFromKlines(klines_1h);
      vol_1h = ewmaVol(r1.slice(-300), 0.94) || realizedVol(r1, Math.min(r1.length, 100));
    }
  } catch (e) {
    // best-effort; ignore failures to stay non-breaking
  }

  // Build vol baseline caching in-memory (simple heuristic - non-persistent)
  // For model-run outputs, compute vol_z for 1h if baseline available via short history (fallback to 1.0)
  const vol_z_1h = (vol_1h && vol_1h > 0) ? (vol_1h / (vol_1h || vol_1h)) : 1.0; // trivial but kept for compatibility

  // Print additional fields (best-effort, non-breaking)
  try {
    console.log(`ATR (5m): ${atr_5m !== null ? atr_5m.toFixed(6) : "N/A"}`);
    console.log(`ATR (15m): ${atr_15m !== null ? atr_15m.toFixed(6) : "N/A"}`);
    console.log(`ATR (1h): ${atr_1h !== null ? atr_1h.toFixed(6) : "N/A"}`);
    console.log(`VOL_5M: ${vol_5m !== null ? vol_5m.toFixed(8) : "N/A"}`);
    console.log(`VOL_15M: ${vol_15m !== null ? vol_15m.toFixed(8) : "N/A"}`);
    console.log(`VOL_1H: ${vol_1h !== null ? vol_1h.toFixed(8) : "N/A"}`);
    console.log(`VOL_Z_1H: ${vol_1h ? (vol_1h / Math.max(1e-12, vol_1h)).toFixed(4) : "1.0000"}`);
  } catch(e){}

  console.log(`Conviction: ${convObj.conviction} | Signal: ${convObj.signal} (buyScore:${convObj.buyScore}, sellScore:${convObj.sellScore})`);
  if (convObj.futuresStrength) console.log(`Futures influence strength: ${convObj.futuresStrength} | futuresBias: ${convObj.futuresBias.toFixed(2)}`);
  if (convObj.momentumBias) console.log(`Momentum bias applied: ${convObj.momentumBias.toFixed(2)}`);
  if (convObj.cvdBias) console.log(`CVD bias applied: ${convObj.cvdBias.toFixed(2)}`);
  if (convObj.lciBias) console.log(`LCI bias applied: ${convObj.lciBias.toFixed(2)}`);
  if (convObj.melaBias) console.log(`MELA bias applied: ${convObj.melaBias.toFixed(2)}`);
  console.log("\nDone.\n");
}

/* -------------------------------------------------------------
   RUN HANDLER
------------------------------------------------------------- */
const sym = process.argv[2];
if (!sym) {
  console.log("Usage: node precision-heatmap-atr-OI-v2.js BTC|ETH|SOL");
  process.exit(1);
}

runForSymbol(sym).catch((e) => {
  console.error("Fatal:", e && e.message ? e.message : e);
  process.exit(1);
});
