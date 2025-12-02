// explanation-engine.js
import {
  callOpenAI_custom,
  callDeepSeekFallback
} from "./conviction-explainer.js";

// -------------------------
// STRICT SIGNAL PROMPT
// -------------------------
function buildSignalPrompt(toon) {
  return `
TOON SNAPSHOT:
${JSON.stringify(toon, null, 2)}

You generate ONLY the trading signal explanation.

Return output in EXACTLY this format:

SIGNAL:
- <Signal>

CONVICTION:
- One short sentence describing the conviction level using ONLY: conviction, buyScore, sellScore.

WHY:
- 2 to 3 bullet points referencing ONLY buyScore, sellScore, conviction, buyPct, sellPct.

STRICT RULES:
- Do NOT mention volatility, ATR, regime, liquidity, LCI, MELA, CVD, or orderbook conditions.
- Do NOT perform market analysis.
- Do NOT mention “market environment”, “conditions”, “pressure”, or “volatility”.
- NO extra sections. NO invented metrics.
`;
}

// -------------------------
// STRICT MARKET ANALYSIS PROMPT
// -------------------------
function buildMarketPrompt(toon) {
  return `
TOON SNAPSHOT:
${JSON.stringify(toon, null, 2)}

Generate a human-style market analysis using the TOON metrics ONLY.

Return output in EXACTLY this format:

MARKET:
- 3 to 6 natural, human-written bullets that sound like a professional trader or analyst.
- Describe the market in plain language: talk about volatility, liquidity, sentiment, stress, participation, flow, momentum.
- Turn raw metrics into human phrasing (e.g., "volatility is picking up", "liquidity looks thin", "order flow is neutral").
- Do NOT mention metric names like "ATR_4h", "LCI score", "VOL_15M". Instead translate them into natural meaning.
- Use simple wording and narrative tone, not technical formatting.

SIGNAL:
- <Signal> (<conviction>)
- One natural-language sentence that ties the signal back to what is happening in the market.

STRICT RULES:
- NO suggestions, no technical section titles, no invented data.
- MUST sound conversational, human, and intuitive.
- Use ONLY the TOON metrics, but rewrite them in natural language.
`;
}

// -------------------------
// MAIN LLM FUNCTIONS
// -------------------------
export async function explainSignalLLM(toon) {
  const prompt = buildSignalPrompt(toon);

  try {
    const txt = await callOpenAI_custom(prompt);
    return txt.trim();
  } catch (err) {
    const fb = await callDeepSeekFallback(prompt);
    return fb.trim();
  }
}

export async function explainMarketLLM(toon) {
  const prompt = buildMarketPrompt(toon);

  try {
    const txt = await callOpenAI_custom(prompt);
    return txt.trim();
  } catch (err) {
    const fb = await callDeepSeekFallback(prompt);
    return fb.trim();
  }
}
