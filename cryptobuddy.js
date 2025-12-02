import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { paymentMiddleware } from "x402-express";

import { generateSignalTOON } from "./signal-engine.js";
import { explainSignalLLM, explainMarketLLM } from "./explanation-engine.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(helmet());
app.use(morgan("dev"));

/* ============================================================
   TELEMETRY
============================================================ */
const telemetry = {
  service: "CryptoBuddy",
  startTime: new Date().toISOString(),
  totalRequests: 0,
  paidRequests: 0,
  byEndpoint: {},
};

function touchMetric(method, url) {
  const key = `${method} ${url}`;
  if (!telemetry.byEndpoint[key]) {
    telemetry.byEndpoint[key] = {
      totalRequests: 0,
      paidRequests: 0,
      lastStatus: null,
      lastAt: null,
      avgLatencyMs: 0,
      _samples: 0,
    };
  }
  return telemetry.byEndpoint[key];
}

app.use((req, res, next) => {
  telemetry.totalRequests++;
  const m = touchMetric(req.method, req.originalUrl);
  m.totalRequests++;
  m.lastAt = new Date().toISOString();

  res.locals._start = process.hrtime.bigint();
  res.on("finish", () => {
    m.lastStatus = res.statusCode;
    const end = process.hrtime.bigint();
    const elapsedMs = Number(end - res.locals._start) / 1e6;
    m._samples++;
    m.avgLatencyMs =
      (m.avgLatencyMs * (m._samples - 1) + elapsedMs) / m._samples;
  });

  next();
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "CryptoBuddy",
    uptimeSeconds: Math.floor(process.uptime()),
    startTime: telemetry.startTime,
    totalRequests: telemetry.totalRequests,
    paidRequests: telemetry.paidRequests,
  });
});

app.get("/metrics", (req, res) => {
  const cleaned = {
    ...telemetry,
    byEndpoint: Object.fromEntries(
      Object.entries(telemetry.byEndpoint).map(([k, v]) => [
        k,
        {
          totalRequests: v.totalRequests,
          paidRequests: v.paidRequests,
          lastStatus: v.lastStatus,
          lastAt: v.lastAt,
          avgLatencyMs: Number(v.avgLatencyMs.toFixed(2)),
        },
      ])
    ),
  };
  res.json(cleaned);
});

/* ============================================================
   X402 LOGGING (before facilitator)
============================================================ */
app.use((req, res, next) => {
  if (process.env.DEV_MODE === "true") return next();
  console.log(`\n🔐 Incoming paid request → ${req.method} ${req.originalUrl}`);
  console.log("📩 XPAYMENT header received:", req.headers["x-payment"]);
  next();
});

/* ============================================================
   X402 PAYMENT CONFIG
============================================================ */
if (!process.env.AGENT_WALLET) {
  console.error("❌ Missing AGENT_WALLET in .env");
  process.exit(1);
}

if (process.env.DEV_MODE === "true") {
  console.log("🔓 X402 Disabled — DEV_MODE=true");
} else {
  console.log("🔧 X402 paymentMiddleware active");
  console.log("🌐 Facilitator URL:", process.env.FACILITATOR_URL);

  app.use(
    paymentMiddleware(process.env.AGENT_WALLET, {
      /* ============================
         1) /signal-simple
      ============================ */
      "POST /signal-simple": {
        price: process.env.PRICE_SIGNAL_SIMPLE || "$0.10",
        network: "base-sepolia",
        config: {
          discoverable: true,
          name: "CryptoBuddy — Simple Signal",
          description:
            "Get a BUY/SELL/HOLD signal plus conviction score only. Cheap endpoint for routing and agents.",
          inputSchema: {
            type: "http",
            method: "POST",
            bodyType: "json",
            bodyFields: {
              symbol: {
                type: "string",
                required: true,
                description: "Symbol (BTC, ETH, SOL, AVAX, etc)",
              },
            },
          },
          outputSchema: {
            symbol: "string",
            timestamp: "string",
            signal: "string",
            conviction: "number",
          },
        },
      },

      /* ============================
         2) /signal
      ============================ */
      "POST /signal": {
        price: process.env.PRICE_SIGNAL_DETAILED || "$1.00",
        network: "base-sepolia",
        config: {
          discoverable: true,
          name: "CryptoBuddy — Detailed Signal (LLM)",
          description:
            "Full BUY/SELL/HOLD signal + conviction + WHY explanation using LLM with TOON metrics.",
          inputSchema: {
            type: "http",
            method: "POST",
            bodyType: "json",
            bodyFields: {
              symbol: {
                type: "string",
                required: true,
                description: "Symbol (BTC, ETH, SOL, AVAX, etc)",
              },
            },
          },
          outputSchema: {
            symbol: "string",
            timestamp: "string",
            signal: "string",
            conviction: "number",
            buyScore: "number",
            sellScore: "number",
            explanation: "string",
          },
        },
      },

      /* ============================
         3) /analysis-simple
      ============================ */
      "POST /analysis-simple": {
        price: process.env.PRICE_ANALYSIS_SIMPLE || "$0.10",
        network: "base-sepolia",
        config: {
          discoverable: true,
          name: "CryptoBuddy — Simple Market Commentary",
          description:
            "Short human-readable market analysis only. No metrics or signal JSON.",
          inputSchema: {
            type: "http",
            method: "POST",
            bodyType: "json",
            bodyFields: {
              symbol: {
                type: "string",
                required: true,
                description: "Symbol (BTC, ETH, SOL, AVAX, etc)",
              },
            },
          },
          outputSchema: {
            symbol: "string",
            timestamp: "string",
            market: "string",
          },
        },
      },

      /* ============================
         4) /analysis
      ============================ */
      "POST /analysis": {
        price: process.env.PRICE_ANALYSIS_DETAILED || "$1.00",
        network: "base-sepolia",
        config: {
          discoverable: true,
          name: "CryptoBuddy — Detailed Market Analysis",
          description:
            "Full TOON metrics + human-readable market analysis + signal context.",
          inputSchema: {
            type: "http",
            method: "POST",
            bodyType: "json",
            bodyFields: {
              symbol: {
                type: "string",
                required: true,
                description: "Symbol (BTC, ETH, SOL, AVAX, etc)",
              },
            },
          },
          outputSchema: {
            toon: "object",
            report: "string",
          },
        },
      },

      url:
        process.env.FACILITATOR_URL ||
        "https://x402.org/facilitator/onchain",
    })
  );
}

/* ============================================================
   POST VERIFICATION LOGGING
============================================================ */
app.use((req, res, next) => {
  if (process.env.DEV_MODE !== "true") {
    console.log(
      `🟢 XPAYMENT VERIFIED by facilitator for → ${req.method} ${req.originalUrl}`
    );
    telemetry.paidRequests++;
    const m = touchMetric(req.method, req.originalUrl);
    m.paidRequests++;
  }
  next();
});

/* ============================================================
   ROUTES
============================================================ */
app.post("/signal-simple", async (req, res) => {
  try {
    const { symbol } = req.body;
    const toon = await generateSignalTOON(symbol);
    res.json({
      symbol: toon.symbol,
      timestamp: toon.timestamp,
      signal: toon.signal,
      conviction: toon.conviction,
    });
  } catch (err) {
    console.error("❌ /signal-simple error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/signal", async (req, res) => {
  try {
    const { symbol } = req.body;
    const toon = await generateSignalTOON(symbol);
    const explanation = await explainSignalLLM(toon);
    res.json({ ...toon, explanation });
  } catch (err) {
    console.error("❌ /signal error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/analysis-simple", async (req, res) => {
  try {
    const { symbol } = req.body;
    const toon = await generateSignalTOON(symbol);
    const full = await explainMarketLLM(toon);
    res.json({
      symbol: toon.symbol,
      timestamp: toon.timestamp,
      market: full.split("SIGNAL:")[0].trim(),
    });
  } catch (err) {
    console.error("❌ /analysis-simple error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/analysis", async (req, res) => {
  try {
    const { symbol } = req.body;
    const toon = await generateSignalTOON(symbol);
    const report = await explainMarketLLM(toon);
    res.json({ toon, report });
  } catch (err) {
    console.error("❌ /analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   X402 DISCOVERY FILE
   (Serves x402.json exactly as required by Discovery API)
============================================================ */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/x402.json", (req, res) => {
  try {
    const filePath = path.join(__dirname, "x402.json");
    const json = fs.readFileSync(filePath, "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(json);
  } catch (err) {
    console.error("Failed to serve x402.json:", err);
    res.status(500).json({ error: "Could not load x402.json" });
  }
});



/* ============================================================
   START SERVER
============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 CryptoBuddy running on port ${PORT}`)
);
