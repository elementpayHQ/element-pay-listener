/**
 * Stellar Soroban event poller for ElementPay order contract.
 *
 * Forwards create / settle / refund diagnostics to the same FastAPI /events/*
 * HMAC endpoints as the EVM ethers listener. Does NOT invoke settle_order —
 * the aggregator signs settle after STK/payout success.
 *
 * Lab contract event layout (create):
 *   topics: [ "order", "created", order_id:BytesN<32>, requester:Address, token:Address ]
 *   value map: { amount, expires_at, fee_amount, message_hash, order_type, provider_id }
 *
 * Env:
 *   STELLAR_NETWORK=testnet|public
 *   STELLAR_ORDER_CONTRACT_ID=C...
 *   STELLAR_RPC_URL= (optional; defaults by network)
 *   FASTAPI_BASE_URL=
 *   LISTENER_WEBHOOK_SECRET=
 *   POLL_MS=4000
 */
require('dotenv').config({
  // Local listener .env is source of truth — a prior bad `export STELLAR_…=CCWG74…`
  // in the same shell must not stick forever (dotenv does not override by default).
  override: true,
});
const fs = require('fs');
const path = require('path');
const { createHmac } = require('node:crypto');
const axios = require('axios');
const express = require('express');
const { decodeScValBase64, coerceTopicOrValue } = require('./scvalXdr');

const NETWORK = (process.env.STELLAR_NETWORK || 'testnet').toLowerCase();
const CONTRACT_ID = (process.env.STELLAR_ORDER_CONTRACT_ID || '').trim();
const RPC_URL =
  process.env.STELLAR_RPC_URL ||
  (NETWORK === 'public'
    ? 'https://soroban-mainnet.stellar.org'
    : 'https://soroban-testnet.stellar.org');
const FASTAPI_BASE_URL = process.env.FASTAPI_BASE_URL;
const LISTENER_SECRET = process.env.LISTENER_WEBHOOK_SECRET;
const POLL_MS = Math.max(2000, parseInt(process.env.POLL_MS || '4000', 10));

/**
 * Soroban contract IDs are full StrKey C-addresses (~56 chars), not abbreviated
 * explorer strings like "CCWG74…". Truncated / ellipsis IDs → RPC -32602
 * "contract ID 1 invalid".
 */
function assertValidContractId(id) {
  if (!id) {
    console.error('STELLAR_ORDER_CONTRACT_ID required (set in element-pay-listener/.env or export)');
    process.exit(1);
  }
  if (id.includes('…') || id.includes('...')) {
    console.error(
      'STELLAR_ORDER_CONTRACT_ID looks truncated (contains …/...).\n' +
        '  Use the full C-address, e.g. CCWG74PM5EFLF7BIO5LZK32VXKD5ONHA7SCRCR4UTVHA4OL5V4NARUK4\n' +
        '  If you exported a short id earlier in this shell:  unset STELLAR_ORDER_CONTRACT_ID\n' +
        '  then restart (listener loads .env with override:true).'
    );
    process.exit(1);
  }
  if (!/^C[A-Z2-7]{55,}$/i.test(id)) {
    console.error(
      `STELLAR_ORDER_CONTRACT_ID invalid (length=${id.length} preview=${id.slice(0, 16)}…).\n` +
        '  Expected a full StrKey starting with C (~56 chars).'
    );
    process.exit(1);
  }
}

assertValidContractId(CONTRACT_ID);

const CURSOR_FILE = path.join(__dirname, `stellar_ledger_cursor_${NETWORK}.txt`);

const processedCreated = new Set();
const processedSettled = new Set();
const processedRefunded = new Set();

function signBody(timestamp, rawBody) {
  const mac = createHmac('sha256', Buffer.from(LISTENER_SECRET, 'utf8'))
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `v1=${mac}`;
}

async function postSigned(pathname, payload) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const raw = JSON.stringify(payload);
  const sig = signBody(ts, raw);
  return axios.post(`${FASTAPI_BASE_URL}${pathname}`, raw, {
    headers: {
      'Content-Type': 'application/json',
      'X-EP-Timestamp': ts,
      'X-EP-Signature': sig,
      'X-EP-Client': 'stellar-listener',
    },
  });
}

function loadCursor() {
  try {
    if (fs.existsSync(CURSOR_FILE)) {
      const n = parseInt(fs.readFileSync(CURSOR_FILE, 'utf8').trim(), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (e) {
    console.warn('cursor load failed', e.message);
  }
  return null;
}

function saveCursor(ledger) {
  try {
    fs.writeFileSync(CURSOR_FILE, String(ledger), 'utf8');
  } catch (e) {
    console.warn('cursor save failed', e.message);
  }
}

async function rpc(method, params) {
  const res = await axios.post(
    RPC_URL,
    { jsonrpc: '2.0', id: 1, method, params },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  if (res.data.error) {
    throw new Error(JSON.stringify(res.data.error));
  }
  return res.data.result;
}

/**
 * Normalize a single RPC topic (json ScVal object | base64 SCVal XDR | primitive).
 *
 * Default Soroban getEvents returns topics as base64 SCVal XDR. Without decoding
 * those to "order"/"created", classifyEvent never matches and events are silent.
 */
function topicParts(topic) {
  if (topic == null) return { kind: 'empty', text: '', hex: '', address: '' };

  // Default RPC: base64 SCVal XDR string
  if (typeof topic === 'string') {
    const decoded = decodeScValBase64(topic);
    if (decoded) {
      return topicParts(decoded);
    }
    // short symbol-like
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(topic) && topic.length <= 32) {
      return { kind: 'symbol', text: topic, hex: '', address: '' };
    }
    // hex order id
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(topic)) {
      return {
        kind: 'bytes',
        text: '',
        hex: topic.replace(/^0x/i, '').toLowerCase(),
        address: '',
      };
    }
    // raw base64 32-byte (non-SCVal)
    try {
      const buf = Buffer.from(topic, 'base64');
      if (buf.length === 32) {
        return { kind: 'bytes', text: '', hex: buf.toString('hex'), address: '' };
      }
    } catch {
      /* ignore */
    }
    return { kind: 'string', text: topic, hex: '', address: '' };
  }

  if (typeof topic === 'object') {
    // xdrFormat=json style (and our decodeScValBase64 shape)
    if (topic.symbol != null) {
      return { kind: 'symbol', text: String(topic.symbol), hex: '', address: '' };
    }
    if (topic.string != null) {
      return { kind: 'string', text: String(topic.string), hex: '', address: '' };
    }
    if (topic.address != null) {
      return {
        kind: 'address',
        text: '',
        hex: '',
        address: String(topic.address),
      };
    }
    if (topic.bytes != null) {
      const b = topic.bytes;
      if (Buffer.isBuffer(b)) {
        return { kind: 'bytes', text: '', hex: b.toString('hex'), address: '' };
      }
      if (typeof b === 'string') {
        if (/^(0x)?[0-9a-fA-F]{64}$/.test(b)) {
          return {
            kind: 'bytes',
            text: '',
            hex: b.replace(/^0x/i, '').toLowerCase(),
            address: '',
          };
        }
        try {
          const buf = Buffer.from(b, 'base64');
          return { kind: 'bytes', text: '', hex: buf.toString('hex'), address: '' };
        } catch {
          return { kind: 'bytes', text: '', hex: String(b).toLowerCase(), address: '' };
        }
      }
      if (Array.isArray(b)) {
        return {
          kind: 'bytes',
          text: '',
          hex: Buffer.from(b).toString('hex'),
          address: '',
        };
      }
    }
  }
  return { kind: 'unknown', text: String(topic), hex: '', address: '' };
}

function topicsList(ev) {
  return ev.topic || ev.topics || [];
}

function valueMap(ev) {
  let v = coerceTopicOrValue(ev.value);
  if (!v) return {};
  if (typeof v === 'object' && !Buffer.isBuffer(v)) {
    // json map style: { map: [ { key: {symbol}, val: ... } ] } or flat
    if (Array.isArray(v.map)) {
      const out = {};
      for (const entry of v.map) {
        const k =
          entry.key?.symbol ||
          entry.key?.string ||
          entry?.key ||
          entry[0]?.symbol ||
          entry[0];
        const val = entry.val !== undefined ? entry.val : entry.value ?? entry[1];
        if (k != null) out[String(k)] = unwrapScVal(val);
      }
      return out;
    }
    // already flat object of primitives
    if (v.amount != null || v.message_hash != null || v.messageHash != null) {
      return {
        amount: v.amount,
        message_hash: v.message_hash || v.messageHash,
        order_type: v.order_type ?? v.orderType,
        requester: v.requester,
        token: v.token,
      };
    }
  }
  return {};
}

function unwrapScVal(val) {
  if (val == null) return val;
  if (typeof val !== 'object') return val;
  if (val.i128 != null) return String(val.i128);
  if (val.u128 != null) return String(val.u128);
  if (val.u32 != null) return Number(val.u32);
  if (val.u64 != null) return String(val.u64);
  if (val.i64 != null) return String(val.i64);
  if (val.string != null) return String(val.string);
  if (val.symbol != null) return String(val.symbol);
  if (val.address != null) return String(val.address);
  if (val.bytes != null) {
    const b = val.bytes;
    if (Buffer.isBuffer(b)) return b.toString('hex');
    if (typeof b === 'string' && /^(0x)?[0-9a-fA-F]+$/.test(b)) {
      return b.replace(/^0x/i, '').toLowerCase();
    }
    if (typeof b === 'string') {
      try {
        return Buffer.from(b, 'base64').toString('hex');
      } catch {
        return b;
      }
    }
  }
  if (val.void !== undefined) return null;
  return val;
}

/**
 * Lab: topics [order, created, order_id, requester, token]
 */
function classifyEvent(ev) {
  const parts = topicsList(ev).map(topicParts);
  const text = parts.map((p) => p.text.toLowerCase()).join(' ');
  if (text.includes('refund')) return 'refunded';
  if (text.includes('settle')) return 'settled';
  if (text.includes('create') || text.includes('created')) return 'created';
  // symbol order + second topic
  if (parts[0]?.text === 'order' && parts[1]?.text === 'created') return 'created';
  if (parts[0]?.text === 'order' && parts[1]?.text === 'settled') return 'settled';
  if (parts[0]?.text === 'order' && parts[1]?.text === 'refunded') return 'refunded';
  return null;
}

function orderIdFromEvent(ev) {
  const parts = topicsList(ev).map(topicParts);
  // Prefer 32-byte topic (lab: topics[2])
  for (const p of parts) {
    if (p.hex && p.hex.length === 64) return p.hex;
  }
  const vm = valueMap(ev);
  for (const key of ['id', 'order_id', 'orderId']) {
    if (vm[key]) {
      const h = String(vm[key]).replace(/^0x/i, '').toLowerCase();
      if (h.length === 64) return h;
    }
  }
  return '';
}

function addressFromTopics(parts, index) {
  const p = parts[index];
  if (!p) return '';
  if (p.address) return p.address;
  if (p.text && (p.text.startsWith('G') || p.text.startsWith('C'))) return p.text;
  return '';
}

async function handleCreated(ev) {
  const parts = topicsList(ev).map(topicParts);
  const orderId = orderIdFromEvent(ev);
  if (!orderId || orderId.length < 8) {
    console.warn('skip created: no orderId', JSON.stringify(ev).slice(0, 400));
    return;
  }
  if (processedCreated.has(orderId)) return;
  processedCreated.add(orderId);

  const vm = valueMap(ev);
  const requester =
    addressFromTopics(parts, 3) ||
    String(vm.requester || '');
  const token =
    addressFromTopics(parts, 4) ||
    String(vm.token || '');
  const amount = String(vm.amount ?? '0');
  const messageHash = String(vm.message_hash || vm.messageHash || '');
  const orderType = Number(vm.order_type ?? vm.orderType ?? 0);
  const transactionHash = String(ev.txHash || ev.transactionHash || '');

  const payload = {
    orderId,
    requester,
    token,
    amount,
    messageHash,
    orderType,
    transactionHash,
    chain: 'stellar',
  };
  try {
    const res = await postSigned('/events/order-created', payload);
    console.log('OrderCreated forwarded', payload.orderId, res.data);
  } catch (err) {
    console.error(
      'OrderCreated forward failed',
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

async function handleSettled(ev) {
  const orderId = orderIdFromEvent(ev);
  if (!orderId) return;
  if (processedSettled.has(orderId)) return;
  processedSettled.add(orderId);
  const payload = {
    orderId,
    transactionHash: String(ev.txHash || ev.transactionHash || ''),
    chain: 'stellar',
  };
  try {
    const res = await postSigned('/events/order-settled', payload);
    console.log('OrderSettled forwarded', payload.orderId, res.data);
  } catch (err) {
    console.error('OrderSettled forward failed', err.message);
  }
}

async function handleRefunded(ev) {
  const orderId = orderIdFromEvent(ev);
  if (!orderId) return;
  if (processedRefunded.has(orderId)) return;
  processedRefunded.add(orderId);
  const payload = {
    orderId,
    transactionHash: String(ev.txHash || ev.transactionHash || ''),
    chain: 'stellar',
  };
  try {
    const res = await postSigned('/events/order-refunded', payload);
    console.log('OrderRefunded forwarded', payload.orderId, res.data);
  } catch (err) {
    console.error('OrderRefunded forward failed', err.message);
  }
}

async function pollOnce() {
  if (!CONTRACT_ID) throw new Error('STELLAR_ORDER_CONTRACT_ID required');
  if (!FASTAPI_BASE_URL || !LISTENER_SECRET) {
    throw new Error('FASTAPI_BASE_URL and LISTENER_WEBHOOK_SECRET required');
  }

  const latest = await rpc('getLatestLedger', null);
  const latestSeq = Number(latest.sequence || latest);
  let start = loadCursor();
  if (!start) {
    start = Math.max(1, latestSeq - 200);
  }
  // RPC rejects ranges that are too large / inverted
  if (start > latestSeq) {
    console.warn('cursor %s past latest %s; resetting', start, latestSeq);
    start = Math.max(1, latestSeq - 50);
  }

  let result;
  try {
    result = await rpc('getEvents', {
      startLedger: start,
      filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
      pagination: { limit: 100 },
      xdrFormat: 'json',
    });
  } catch (e) {
    // Some nodes reject xdrFormat; retry base64 SCVal topics
    console.warn('getEvents xdrFormat=json failed (%s); retrying default', e.message || e);
    result = await rpc('getEvents', {
      startLedger: start,
      filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
      pagination: { limit: 100 },
    });
  }

  const events = result.events || [];
  console.log(
    'poll startLedger=%s latest=%s events=%s',
    start,
    result.latestLedger || latestSeq,
    events.length
  );
  for (const ev of events) {
    const parts = topicsList(ev).map(topicParts);
    const kind = classifyEvent(ev);
    if (kind === 'created') await handleCreated(ev);
    else if (kind === 'settled') await handleSettled(ev);
    else if (kind === 'refunded') await handleRefunded(ev);
    else {
      // Make decode failures visible — silent unclassified was the Path A gap
      const preview = parts
        .map((p) => p.text || p.hex?.slice(0, 12) || p.address?.slice(0, 12) || p.kind)
        .join('|');
      console.warn(
        'unclassified event ledger=%s tx=%s topics=%s',
        ev.ledger || ev.ledgerCloseTime || '?',
        String(ev.txHash || '').slice(0, 16),
        preview
      );
    }
  }

  const next = Number(result.latestLedger || latestSeq);
  if (Number.isFinite(next) && next >= start) {
    saveCursor(next);
  }
}

async function loop() {
  console.log(
    'stellar-listener start network=%s contract=%s rpc=%s fastapi=%s',
    NETWORK,
    CONTRACT_ID,
    RPC_URL,
    FASTAPI_BASE_URL || '(missing)'
  );
  for (;;) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('poll error', e.message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const healthApp = express();
healthApp.get('/health', (_req, res) =>
  res.json({ ok: true, network: NETWORK, contract: CONTRACT_ID })
);
const healthPort = parseInt(process.env.HEALTH_PORT || '8089', 10);
healthApp.listen(healthPort, () => console.log('health on', healthPort));

loop().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
