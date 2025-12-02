// conviction-explainer.js
// Clean CryptoBuddy Edition — no CLI, no OpenAI SDK, no SYSTEM_PROMPT
// Provides:
//   - parsePrecisionOutput()
//   - callOpenAI_custom()      → main LLM (DeepSeek via OpenRouter)
//   - callDeepSeekFallback()   → fallback LLM (OpenAI via OpenRouter)

import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --------------------
// Setup for ESM paths
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======================================================================
// NEW FULL PRECISION MODEL PARSER (regex-based)
// ======================================================================
export function parsePrecisionOutput(stdout, symbol) {
  const metrics = {
    symbol,
    signal: "UNKNOWN",
    conviction: 0,
    buyScore: 0,
    sellScore: 0,
    buyPct: 0,
    sellPct: 0,
    atr4h: 0,
    atr1h: 0,
    atr15m: 0,
    atr5m: 0,
    vol5m: 0,
    vol15m: 0,
    vol1h: 0,
    cvdScore: 0,
    lciScore: 0,
    lciConcentrationPct: 0,
    melaScore: 0,
    melaAgreementPct: 0,
    regime: "UNKNOWN",
  };

  // ----------------------------------------------------------
  // Conviction + Signal + buy/sell scores
  // ----------------------------------------------------------
  const sigMatch = stdout.match(
    /Conviction:\s*([0-9.]+)\s*\|\s*Signal:\s*([A-Z]+)\s*\(buyScore:([0-9.]+),\s*sellScore:([0-9.]+)\)/i
  );
  if (sigMatch) {
    metrics.conviction = Number(sigMatch[1]);
    metrics.signal = sigMatch[2];
    metrics.buyScore = Number(sigMatch[3]);
    metrics.sellScore = Number(sigMatch[4]);
  }

  // ----------------------------------------------------------
  // Dominance %
  // ----------------------------------------------------------
  const buyDom = stdout.match(/Buy-Side Dominance:\s*([0-9.]+)%/i);
  const sellDom = stdout.match(/Sell-Side Dominance:\s*([0-9.]+)%/i);
  if (buyDom) metrics.buyPct = Number(buyDom[1]);
  if (sellDom) metrics.sellPct = Number(sellDom[1]);

  // ----------------------------------------------------------
  // ATR values
  // ----------------------------------------------------------
  const atr4h = stdout.match(/ATR \(4h\):\s*([0-9.]+)/i);
  const atr1h = stdout.match(/ATR \(1h\):\s*([0-9.]+)/i);
  const atr15m = stdout.match(/ATR \(15m\):\s*([0-9.]+)/i);
  const atr5m = stdout.match(/ATR \(5m\):\s*([0-9.]+)/i);
  if (atr4h) metrics.atr4h = Number(atr4h[1]);
  if (atr1h) metrics.atr1h = Number(atr1h[1]);
  if (atr15m) metrics.atr15m = Number(atr15m[1]);
  if (atr5m) metrics.atr5m = Number(atr5m[1]);

  // ----------------------------------------------------------
  // Volumes
  // ----------------------------------------------------------
  const vol5 = stdout.match(/VOL_5M:\s*([0-9.eE+-]+)/i);
  const vol15 = stdout.match(/VOL_15M:\s*([0-9.eE+-]+)/i);
  const vol1 = stdout.match(/VOL_1H:\s*([0-9.eE+-]+)/i);
  if (vol5) metrics.vol5m = Number(vol5[1]);
  if (vol15) metrics.vol15m = Number(vol15[1]);
  if (vol1) metrics.vol1h = Number(vol1[1]);

  // ----------------------------------------------------------
  // CVD score
  // ----------------------------------------------------------
  const cvd = stdout.match(/cvdScore:([0-9]+)/i);
  if (cvd) metrics.cvdScore = Number(cvd[1]);

  // ----------------------------------------------------------
  // LCI score + concentration
  // ----------------------------------------------------------
  const lci = stdout.match(/LCI:\s*concentrated\s*([0-9.]+)%\s*->\s*lciScore:([0-9]+)/i);
  if (lci) {
    metrics.lciConcentrationPct = Number(lci[1]);
    metrics.lciScore = Number(lci[2]);
  }

  // ----------------------------------------------------------
  // MELA score + agreement%
  // ----------------------------------------------------------
  const mela = stdout.match(/MELA:\s*agreement\s*([0-9.]+)%\s*->\s*melaScore:([0-9]+)/i);
  if (mela) {
    metrics.melaAgreementPct = Number(mela[1]);
    metrics.melaScore = Number(mela[2]);
  }

  // ----------------------------------------------------------
  // Regime
  // ----------------------------------------------------------
  const regime = stdout.match(/\(regime:\s*([A-Z_]+)\)/i);
  if (regime) metrics.regime = regime[1];

  return metrics;
}

// ======================================================================
// OPENROUTER LLM: PRIMARY
// ======================================================================
export async function callOpenAI_custom(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY for callOpenAI_custom()");
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "You analyze crypto ONLY using provided TOON metrics. Never invent metrics. Follow the exact output format the user requests. No extra sections."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 300
    })
  });

  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

// ======================================================================
// OPENROUTER LLM: FALLBACK
// ======================================================================
export async function callDeepSeekFallback(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY for fallback.");
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Fallback LLM. Follow the requested output format EXACTLY. Use only TOON metrics. No invented indicators. No extra sections."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 300
    })
  });

  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

// ======================================================================
// NO CLI MODE ANYMORE (clean module)
// ======================================================================
