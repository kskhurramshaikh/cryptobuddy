import fetch from "node-fetch";
import { CdpClient } from "@coinbase/cdp-sdk";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import dotenv from "dotenv";

dotenv.config();

const BASE_URL = "http://localhost:3000";
const SYMBOL = "BTC";

// -------------------------------------------------------------------------
// Load CDP Wallet EXACTLY like buyer-dashboard.js uses (evm.getAccount)
// -------------------------------------------------------------------------
async function loadCdpWallet() {
  const cdp = new CdpClient();   // ← no config needed

  const account = await cdp.evm.getAccount({
    address: process.env.CDP_ACCOUNT_ADDRESS,
  });

  console.log("\n🔐 CDP Wallet Loaded:");
  console.log("   Address:", account.address);
  console.log("   Network:", account.network);

  return account;
}

// -------------------------------------------------------------------------
async function callPaidEndpoint(fetchWithPay, path, body = {}) {
  const res = await fetchWithPay(BASE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const receipt = decodeXPaymentResponse(
    res.headers.get("x-payment-response")
  );

  console.log("\n🧾 Receipt:", receipt);

  console.log("\n📦 Response:");
  console.log(await res.text());
}

// -------------------------------------------------------------------------
async function run() {
  const account = await loadCdpWallet();

  const fetchWithPay = wrapFetchWithPayment(fetch, account, {
    network: "base-sepolia",
    facilitatorUrl: process.env.FACILITATOR_URL,
    debug: true,
  });

  await callPaidEndpoint(fetchWithPay, "/signal-simple", { symbol: SYMBOL });
  await callPaidEndpoint(fetchWithPay, "/signal",        { symbol: SYMBOL });
  await callPaidEndpoint(fetchWithPay, "/analysis-simple",{ symbol: SYMBOL });
  await callPaidEndpoint(fetchWithPay, "/analysis",      { symbol: SYMBOL });

  console.log("\n🎉 Done.");
}

run().catch((err) => console.error("❌ Test Error:", err));
