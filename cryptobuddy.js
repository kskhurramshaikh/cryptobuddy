import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { paymentMiddleware } from "x402-express";
import { facilitator, createCdpAuthHeaders } from "@coinbase/x402";

import { generateSignalTOON } from "./signal-engine.js";
import { explainSignalLLM, explainMarketLLM } from "./explanation-engine.js";

import { readFile } from "fs/promises";


dotenv.config();

const app = express();
app.use(cors());

app.use(express.json());

// Allow Tailwind CDN / Ethers CDN / Cryptologos
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": [
          "'self'",
	  "'unsafe-inline'",   // ⭐ FIXES SEARCH + INTERACTIVITY
          "https://cdn.tailwindcss.com",
          "https://cdn.jsdelivr.net"
        ],
        "img-src": [
          "'self'",
          "data:",
          "https://cryptologos.cc"
        ],
        "style-src": [
          "'self'",
          "'unsafe-inline'"
        ],
        "connect-src": [
          "'self'"
        ]
      },
    },
  })
);

app.use(morgan("dev"));

// ⬇⬇ ADD THIS BLOCK HERE
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Serve root files like blockverse-logo.png
app.use(express.static(__dirname));



app.use(
  "/.well-known",
  express.static(path.join(__dirname, ".well-known"))
);
// ⬆⬆ ADD THIS BLOCK HERE


// X402Scan discovery: required 402-style root response
app.get("/", (req, res) => {
  res.status(402).json({
    x402Version: 1,
    error: "Payment Required",
    payer: null,
    accepts: [],

// 🔥 Add service metadata
    serviceName: "CryptoBuddy",
    description: "AI-powered trading signals, market insight, and predictive analysis.",

    x402Metadata: "https://cryptobuddy-96zq.onrender.com/.well-known/x402scan.json"
  });
});


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
   X402 DISCOVERY MANIFEST (Bazaar)
============================================================ */
app.get("/x402.json", async (req, res) => {
  try {
    const json = await readFile("./x402.json", "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(json);
  } catch (err) {
    console.error("❌ Failed to load x402.json:", err);
    res.status(500).json({ error: "Failed to load x402.json" });
  }
});

/* ============================================================
   SIGNER UI STATIC FILE
============================================================ */
// Serve the signer UI (no duplicate imports)
app.get("/trade-terminal", (req, res) => {
  res.sendFile(path.join(__dirname, "xp-signer-ui.html"));
});

app.use("/assets", express.static(path.join(__dirname)));  
// allows blockverse-logo.png to load correctly




/* ============================================================
   X402 LOGGING (before facilitator)
============================================================ */
app.use((req, res, next) => {
  if (process.env.DEV_MODE === "true") return next();
  console.log(`\n🔐 Incoming paid request → ${req.method} ${req.originalUrl}`);
  console.log("📩 XPAYMENT header received:", req.headers["x-payment"]);
  next();
});


// -----------------------------
// PREPARE PAYMENT (dynamic service pricing)
// -----------------------------
app.get("/prepare-payment", (req, res) => {
  try {
    const symbol = req.query.symbol || "BTC";
    const service = req.query.service || "signal-simple";

    // Map of service → endpoint + price env var
    const SERVICE_MAP = {
      "signal-simple": {
        endpoint: "signal-simple",
        price: Number(process.env.PRICE_SIGNAL_SIMPLE_USDC || 0.10),
      },
      "signal": {
        endpoint: "signal",
        price: Number(process.env.PRICE_SIGNAL_DETAILED_USDC || 1.00),
      },
      "analysis-simple": {
        endpoint: "analysis-simple",
        price: Number(process.env.PRICE_ANALYSIS_SIMPLE_USDC || 0.10),
      },
      "analysis": {
        endpoint: "analysis",
        price: Number(process.env.PRICE_ANALYSIS_DETAILED_USDC || 1.00),
      },
    };

    const svc = SERVICE_MAP[service];
    if (!svc) return res.status(400).json({ error: "Invalid service" });

    const amount6 = Math.round(svc.price * 1e6); // convert USDC to 6 decimals

    const accept = {
      payTo: process.env.AGENT_WALLET,
      asset: process.env.USDC_CONTRACT,
      maxAmountRequired: amount6,
      maxTimeoutSeconds: Number(process.env.PAYMENT_TIMEOUT || 300),
      resource: `https://${req.get("host")}/${svc.endpoint}`,
      extra: { name: "USD Coin", version: "2" },
    };

    res.json({ accept, symbol, service });
  } catch (err) {
    console.error("❌ /prepare-payment error:", err);
    res.status(500).json({ error: err.message });
  }
});


// -----------------------------
// SUBMIT PROOF (dynamic endpoint routing)
// -----------------------------
app.post("/submit-proof", async (req, res) => {
  try {
    const { signedXPayment, symbol, service } = req.body || {};

    if (!signedXPayment) return res.status(400).json({ error: "signedXPayment is required" });
    if (!symbol) return res.status(400).json({ error: "symbol is required" });
    if (!service) return res.status(400).json({ error: "service is required" });

    // Validate service routing
    const VALID = ["signal-simple", "signal", "analysis-simple", "analysis"];
    if (!VALID.includes(service)) {
      return res.status(400).json({ error: "Invalid service" });
    }

    // Encode signed XPAYMENT JSON → Base64
    const encoded = Buffer.from(
      typeof signedXPayment === "string"
        ? signedXPayment
        : JSON.stringify(signedXPayment)
    ).toString("base64");

    // Forward to internal paid endpoint
    const target = `${req.protocol}://${req.get("host")}/${service}?symbol=${encodeURIComponent(symbol)}`;

    console.log(`➡ Forwarding XPAYMENT → ${target}`);

    const r = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": encoded,
      },
      body: JSON.stringify({}),
    });

    const txt = await r.text();

    try {
      const json = JSON.parse(txt);
      return res.json(json);
    } catch {
      return res.type("text").send(txt);
    }
  } catch (err) {
    console.error("❌ /submit-proof error:", err);
    res.status(500).json({ error: err.message });
  }
});


/* ============================================================
   SIGNER SUBMIT → forwards to internal signal generator
============================================================ */
app.post("/signer-submit", async (req, res) => {
  try {
    const symbol = req.body?.symbol;
    if (!symbol) return res.status(400).json({ error: "symbol is required" });

    const toon = await generateSignalTOON(symbol);

    return res.json({
      symbol: toon.symbol,
      timestamp: toon.timestamp,
      signal: toon.signal,
      conviction: toon.conviction,
    });

  } catch (err) {
    console.error("❌ /signer-submit error:", err);
    res.status(500).json({ error: err.message });
  }
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
  console.log("🌐 Facilitator URL:", facilitator);

 app.use(
  paymentMiddleware(
    process.env.AGENT_WALLET,

    // 2️⃣ ROUTES OBJECT (unchanged)
    {
     "POST /signal-simple": {
        price: process.env.PRICE_SIGNAL_SIMPLE || "$0.10",
        network: "base",
        config: {
          discoverable: true,
	  resource: "https://cryptobuddy-96zq.onrender.com/signal-simple",
          mimeType: "application/json",
          description: "Get a BUY/SELL/HOLD signal plus conviction only.",
          inputSchema: {
            queryParams: {
              symbol: { 
		type: "string", 
		description: "Enter Coin Symbol for the AI Signal e.g. BTC ETH SOL etc.",
		required: true 
		},
            },
          },

	   outputSchema: {
		type: "object",
		properties: {
            		symbol: { type: "string"},
            		timestamp: { type: "string"},
            		signal: { type: "string"},
            		conviction: { type: "number"}
	},
          },
        },
      },

      "POST /signal": {
        price: process.env.PRICE_SIGNAL_DETAILED || "$1.00",
        network: "base",
        config: {
          discoverable: true,
          resource: "https://cryptobuddy-96zq.onrender.com/signal",
          mimeType: "application/json",
          description: "Signal + conviction + LLM explanation",
          inputSchema: {
            queryParams: {
              symbol: { 
		type: "string",
		description: "Enter Coin Symbol for the AI Signal e.g. BTC ETH SOL etc.", 
		required: true 
		},
            },
          },
          outputSchema: {
		type: "object",
		properties: {
	        symbol: { type: "string"},
        	timestamp: {type: "string"},
            	signal: { type: "string"},
            	conviction: { type: "number"},
            	buyScore: { type: "number"},
            	sellScore: { type: "number"},
            	explanation: { type: "string"},
	},
          },
        },
      },


      "POST /analysis-simple": {
        price: process.env.PRICE_ANALYSIS_SIMPLE || "$0.10",
        network: "base",
        config: {
          discoverable: true,
          resource: "https://cryptobuddy-96zq.onrender.com/analysis-simple",
          mimeType: "application/json",
          name: "CryptoBuddy — Simple Market Commentary",
          description: "Short market commentary only.",
          inputSchema: {
            queryParams: {
              symbol: { 
		type: "string",
		description: "Enter Coin Symbol for the AI Market Summary e.g. BTC ETH SOL etc.", 
		required: true 
		},
            },
          },

          outputSchema: {
	type: "object",
	properties: {
            symbol: { type: "string"},
            timestamp: { type: "string"},
            market: { type: "string"},
          },
        },
      },
},


      "POST /analysis": {
        price: process.env.PRICE_ANALYSIS_DETAILED || "$1.00",
        network: "base",
        config: {
          discoverable: true,
          resource: "https://cryptobuddy-96zq.onrender.com/analysis",
          mimeType: "application/json",
          name: "CryptoBuddy — Detailed Market Analysis",
          description: "Full TOON metrics + commentary",
          inputSchema: {
            queryParams: {
              symbol: { 
		type: "string",
	description: "Enter Coin Symbol for the AI Detailed Market Summary e.g. BTC ETH SOL etc.", 
		required: true 
		},
            },
          },
          outputSchema: {
	type: "object",
	properties: {

            toon: { type: "object"},
            report: { type: "string"},
          },
        },
      },
    },
},
    // 3️⃣ FACILITATOR CONFIG (REQUIRED FOR CDP)
    {
      url: "https://api.cdp.coinbase.com/platform/v2/x402",	
   createAuthHeaders: facilitator.createAuthHeaders,
      
    }
  )
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
    //const { symbol } = req.body;
   const symbol = req.body?.symbol || req.query?.symbol;
    if (!symbol) return res.status(400).json({ error: "symbol is required" });

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
    //const { symbol } = req.body;
    const symbol = req.body?.symbol || req.query?.symbol;
    if (!symbol) return res.status(400).json({ error: "symbol is required" });



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
    //const { symbol } = req.body;
    const symbol = req.body?.symbol || req.query?.symbol;
    if (!symbol) return res.status(400).json({ error: "symbol is required" });

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
   // const { symbol } = req.body;

    const symbol = req.body?.symbol || req.query?.symbol;
    if (!symbol) return res.status(400).json({ error: "symbol is required" });

    const toon = await generateSignalTOON(symbol);
    const report = await explainMarketLLM(toon);
    res.json({ toon, report });
  } catch (err) {
    console.error("❌ /analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   START SERVER
============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 CryptoBuddy running on port ${PORT}`)
);
