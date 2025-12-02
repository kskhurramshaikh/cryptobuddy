import { exec } from "child_process";
import { parsePrecisionOutput } from "./conviction-explainer.js";

export async function runPrecision(symbol) {
  return new Promise((resolve, reject) => {
    exec(
      `node precision-heatmap-atr-OI-v2.js ${symbol}`,
      { maxBuffer: 20 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(stdout.toString());
      }
    );
  });
}

export async function generateSignalTOON(symbol) {
  const stdout = await runPrecision(symbol);

  const m = parsePrecisionOutput(stdout, symbol);

  // ---- FINAL RAW TOON SNAPSHOT ----
  const toon = {
    symbol,
    timestamp: new Date().toISOString(),

    // Core
    signal: m.signal,
    conviction: m.conviction,
    buyScore: m.buyScore,
    sellScore: m.sellScore,

    // Dominance
    buyPct: m.buyPct,
    sellPct: m.sellPct,

    // ATR
    atr_4h: m.atr4h,
    atr_1h: m.atr1h,
    atr_15m: m.atr15m,
    atr_5m: m.atr5m,

    // VOL
    vol_1h: m.vol1h,
    vol_15m: m.vol15m,
    vol_5m: m.vol5m,

    // Structural
    cvdScore: m.cvdScore,
    lciScore: m.lciScore,
    lciConcentrationPct: m.lciConcentrationPct,
    melaScore: m.melaScore,
    melaAgreementPct: m.melaAgreementPct,

    // Regime
    regime: m.regime
  };

  return toon;
}
