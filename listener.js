require('dotenv').config();
const { ethers } = require('ethers');
const { createHmac } = require('node:crypto');
const axios = require('axios');
const abi = require('./abi.json');

let provider, contract;
let reconnectAttempts = 0;
const MAX_RECONNECTS = 5;

let lastBlockTime = Date.now();
let lastSeenBlock = null;

const FASTAPI_BASE_URL = process.env.FASTAPI_BASE_URL;
const LISTENER_SECRET  = process.env.LISTENER_WEBHOOK_SECRET;

function signBody(timestamp, rawBody) {
  const mac = createHmac('sha256', Buffer.from(LISTENER_SECRET, 'utf8'))
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `v1=${mac}`;
}

async function postSigned(path, payload) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const raw = JSON.stringify(payload);
  const sig = signBody(ts, raw);

  return axios.post(`${FASTAPI_BASE_URL}${path}`, raw, {
    headers: {
      'Content-Type': 'application/json',
      'X-EP-Timestamp': ts,
      'X-EP-Signature': sig,
      'X-EP-Client': 'listener',
    },
  });
}

const processedOrderCreated = new Set();
const processedOrderSettled = new Set();
const processedOrderRefunded = new Set();

// --- Setup Event Handlers ---
async function handleOrderCreated(...args) {
  const event = args[args.length - 1];
  const orderId = event.args?.orderId?.toString() || "";

  // Idempotency check
  if (processedOrderCreated.has(orderId)) {
    console.log(`⏩ Skipping duplicate OrderCreated for orderId: ${orderId}`);
    return;
  }
  processedOrderCreated.add(orderId);

  console.log("📥 OrderCreated received:", event.args);

  const payload = {
    orderId: orderId,
    requester: event.args?.requester || "",
    token: event.args?.token || "",
    amount: event.args?.amount?.toString() || "0",
    messageHash: event.args?.messageHash || "",
    orderType: Number(event.args?.orderType ?? 0),
    transactionHash: event.log?.transactionHash?.toString() || ""
  };

  try {
    const res = await postSigned("/events/order-created", payload);

    console.log("✅ OrderCreated forwarded:", res.data);
  } catch (err) {
  if (err.response) {
    console.error("❌ OrderCreated forwarding failed with status:", err.response.status);
    console.error("📨 Response data:", err.response.data);
  } else {
    console.error("❌ OrderCreated forwarding failed:", err.message);
  }
  console.error("📦 Payload:", payload);
}

}

async function handleOrderSettled(...args) {
  const event = args[args.length - 1];
  const orderId = event.args?.orderId?.toString() || event.args[0]?.toString() || "";
  // Idempotency check
  if (processedOrderSettled.has(orderId)) {
    console.log(`⏩ Skipping duplicate OrderSettled for orderId: ${orderId}`);
    return;
  }
  processedOrderSettled.add(orderId);

  console.log("📥 OrderSettled received:", event.args);

  const payload = {
    orderId: orderId,
    transactionHash: event?.log?.transactionHash || null
  };

  try {
    const res = await postSigned("/events/order-settled", payload);
    console.log("✅ OrderSettled forwarded:", res.data);
  } catch (err) {
    console.error("❌ OrderSettled forwarding failed:", err.message);
    console.error("📦 Payload:", payload);
  }
}

async function handleOrderRefunded(...args) {
  const event = args[args.length - 1];
  const orderId = event.args?.orderId?.toString() || event.args[0]?.toString() || "";

  // Idempotency check
  if (processedOrderRefunded.has(orderId)) {
    console.log(`⏩ Skipping duplicate OrderRefunded for orderId: ${orderId}`);
    return;
  }
  processedOrderRefunded.add(orderId);

  console.log("📥 OrderRefunded received:", event.args);

  const payload = {
    orderId: orderId,
    transactionHash: event?.log?.transactionHash || null
  };

  try {
    const res = await postSigned("/events/order-refunded", payload);
    console.log("✅ OrderRefunded forwarded:", res.data);
  } catch (err) {
    console.error("❌ OrderRefunded forwarding failed:", err.message);
    console.error("📦 Payload:", payload);
  }
}

// --- Reconnection Logic ---
function reconnectWithBackoff() {
  if (reconnectAttempts >= MAX_RECONNECTS) {
    console.error("🛑 Max reconnection attempts reached. Exiting.");
    reconnectAttempts = 0;
  }

  const delay = Math.min(5000 * 2 ** reconnectAttempts, 30000);
  console.warn(`🔁 Reconnecting in ${delay / 1000}s... (Attempt ${reconnectAttempts + 1})`);
  setTimeout(() => {
    reconnectAttempts++;
    setupListeners();
  }, delay);
}

// --- Setup Listeners ---
function setupListeners() {
  console.log("🔧 Initializing provider and listeners...");
  provider = new ethers.WebSocketProvider(process.env.RPC_WS_URL);
  contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, provider);

  contract.removeAllListeners(); 
  console.log("🧹 Removed existing listeners.");

  // Keep-alive
  provider.on("block", async (blockNumber) => {
    console.log("💓 New block:", blockNumber);
    lastBlockTime = Date.now();
    // Backfill missed events
    if (lastSeenBlock && blockNumber > lastSeenBlock) {
      const fromBlock = lastSeenBlock + 1;
      const toBlock = blockNumber;
      try {
        const createdEvents = await contract.queryFilter("OrderCreated", fromBlock, toBlock);
        createdEvents.forEach(e => handleOrderCreated(e));
        const settledEvents = await contract.queryFilter("OrderSettled", fromBlock, toBlock);
        settledEvents.forEach(e => handleOrderSettled(e));
        const refundedEvents = await contract.queryFilter("OrderRefunded", fromBlock, toBlock);
        refundedEvents.forEach(e => handleOrderRefunded(e));
      } catch (err) {
        console.error("❌ Error during backfill:", err.message);
      }
    }
    lastSeenBlock = blockNumber;
  });

  // Reconnect if no blocks are received for 60s
  setInterval(() => {
    if (Date.now() - lastBlockTime > 60000) {
      console.warn("⚠️ No blocks for 60s. Forcing reconnect...");
      provider.destroy?.(); // ethers v6
      setupListeners(); // Reinitialize
    }
  }, 30000);

  provider._websocket?.on("open", () => {
    reconnectAttempts = 0;
    console.log("✅ WebSocket connected");
  });

  provider._websocket?.on("close", (code, reason) => {
    console.warn(`⚠️ WebSocket closed: ${code} - ${reason}`);
    reconnectWithBackoff();
  });

  provider._websocket?.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
  });

  // Register event listeners
  contract.on("OrderCreated", handleOrderCreated);
  contract.on("OrderSettled", handleOrderSettled);
  contract.on("OrderRefunded", handleOrderRefunded);

  console.log("🟢 Listeners registered. Awaiting events...");
}

// ──────────────────────────────────────────────────────────────
// Health endpoint
// ──────────────────────────────────────────────────────────────
const express = require('express');
const healthApp = express();
const healthPort = process.env.HEALTH_PORT || 3000;

healthApp.get('/healthz', (_req, res) => {
  const isStale = Date.now() - lastBlockTime > 60000;
  res.json({
    status: isStale ? 'stale' : 'ok',
    lastBlock: lastBlockTime,
    uptime: process.uptime(),
  });
});


healthApp.listen(healthPort, () => {
  console.log(`🩺 Health check listening on port ${healthPort}`);
});

setupListeners();
