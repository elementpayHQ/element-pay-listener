require('dotenv').config();
const { ethers } = require('ethers');
const { createHmac } = require('node:crypto');
const axios = require('axios');
const abi = require('./abi.json');
const BackfillManager = require('./backfillManager');
const BlockStorage = require('./blockStorage');
const { createForwarder } = require('./forwarder');

let provider, contract;
let reconnectAttempts = 0;
const MAX_RECONNECTS = 5;

let lastBlockTime = Date.now();
let backfillManager = null;
let staleWatchdog = null;

// Chain configuration
const LISTENER_CHAIN = process.env.LISTENER_CHAIN || 'unknown';

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

// Events are marked as handled only after the backend accepts them, so a
// failed delivery is retried when the event is seen again (live or backfill).
const forwarder = createForwarder({ post: postSigned });

// --- Setup Event Handlers ---
async function handleOrderCreated(...args) {
  const event = args[args.length - 1];
  const orderId = event.args?.orderId?.toString() || "";

  if (forwarder.isDelivered(`OrderCreated:${orderId}`)) {
    console.log(`⏩ Skipping duplicate OrderCreated for orderId: ${orderId}`);
    return;
  }

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

  const result = await forwarder.forward(`OrderCreated:${orderId}`, "/events/order-created", payload);
  if (result.status === 'delivered') console.log("✅ OrderCreated forwarded:", result.response?.data);
}

async function handleOrderSettled(...args) {
  const event = args[args.length - 1];
  const orderId = event.args?.orderId?.toString() || event.args[0]?.toString() || "";
  if (forwarder.isDelivered(`OrderSettled:${orderId}`)) {
    console.log(`⏩ Skipping duplicate OrderSettled for orderId: ${orderId}`);
    return;
  }

  console.log("📥 OrderSettled received:", event.args);

  const payload = {
    orderId: orderId,
    transactionHash: event?.log?.transactionHash || null
  };

  const result = await forwarder.forward(`OrderSettled:${orderId}`, "/events/order-settled", payload);
  if (result.status === 'delivered') console.log("✅ OrderSettled forwarded:", result.response?.data);
}

async function handleOrderRefunded(...args) {
  const event = args[args.length - 1];
  const orderId = event.args?.orderId?.toString() || event.args[0]?.toString() || "";

  if (forwarder.isDelivered(`OrderRefunded:${orderId}`)) {
    console.log(`⏩ Skipping duplicate OrderRefunded for orderId: ${orderId}`);
    return;
  }

  console.log("📥 OrderRefunded received:", event.args);

  const payload = {
    orderId: orderId,
    transactionHash: event?.log?.transactionHash || null
  };

  const result = await forwarder.forward(`OrderRefunded:${orderId}`, "/events/order-refunded", payload);
  if (result.status === 'delivered') console.log("✅ OrderRefunded forwarded:", result.response?.data);
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
  
  // Clean up old storage files on startup (senior dev practice)
  BlockStorage.cleanupOldFiles();
  
  provider = new ethers.WebSocketProvider(process.env.RPC_WS_URL);
  contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, provider);
  
  // Initialize backfill manager
  backfillManager = new BackfillManager(contract, LISTENER_CHAIN);
  backfillManager.initialize();

  contract.removeAllListeners(); 
  console.log("🧹 Removed existing listeners.");

  // Keep-alive
  provider.on("block", async (blockNumber) => {
    console.log("💓 New block:", blockNumber);
    lastBlockTime = Date.now();
    
    // Handle backfill through the BackfillManager
    if (backfillManager) {
      await backfillManager.handleNewBlock(blockNumber, {
        handleOrderCreated,
        handleOrderSettled,
        handleOrderRefunded
      });
    }
  });

  // Reconnect if no blocks are received for 60s. setupListeners() runs on
  // every reconnect, so clear the previous watchdog first; otherwise each
  // reconnect adds another timer and a later stall reconnects once per timer.
  if (staleWatchdog) clearInterval(staleWatchdog);
  staleWatchdog = setInterval(() => {
    if (Date.now() - lastBlockTime > 60000) {
      console.warn("⚠️ No blocks for 60s. Forcing reconnect...");
      lastBlockTime = Date.now(); // give the new connection a full window
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
