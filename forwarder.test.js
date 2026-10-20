const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createForwarder, isRetryable } = require('./forwarder');

const quiet = { error() {}, warn() {} };
const noSleep = async () => {};
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });
const networkError = () => Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });

test('delivers once and skips the same event afterwards', async () => {
  let calls = 0;
  const f = createForwarder({ post: async () => { calls++; return { data: 'ok' }; }, sleep: noSleep, logger: quiet });
  assert.equal((await f.forward('OrderCreated:1', '/events/order-created', {})).status, 'delivered');
  assert.equal((await f.forward('OrderCreated:1', '/events/order-created', {})).status, 'duplicate');
  assert.equal(calls, 1);
});

test('a failed delivery is not marked, so the next sighting forwards it again', async () => {
  let up = false;
  let calls = 0;
  const post = async () => { calls++; if (!up) throw httpError(503); return { data: 'ok' }; };
  const f = createForwarder({ post, retryDelaysMs: [1, 1], sleep: noSleep, logger: quiet });

  const first = await f.forward('OrderCreated:7', '/events/order-created', {});
  assert.equal(first.status, 'failed');
  assert.equal(f.isDelivered('OrderCreated:7'), false);
  assert.equal(calls, 3); // initial attempt + 2 retries

  up = true; // backend recovers; backfill or a re-emitted event sees it again
  assert.equal((await f.forward('OrderCreated:7', '/events/order-created', {})).status, 'delivered');
  assert.equal(f.isDelivered('OrderCreated:7'), true);
});

test('retries transient failures with the configured backoff, then succeeds', async () => {
  const outcomes = [networkError(), httpError(502), httpError(429)];
  const slept = [];
  const post = async () => { const o = outcomes.shift(); if (o) throw o; return { data: 'ok' }; };
  const f = createForwarder({ post, retryDelaysMs: [10, 20, 40, 80], sleep: async (ms) => { slept.push(ms); }, logger: quiet });
  assert.equal((await f.forward('OrderSettled:3', '/events/order-settled', {})).status, 'delivered');
  assert.deepEqual(slept, [10, 20, 40]);
});

test('does not retry client errors other than 409, and leaves them unmarked', async () => {
  let calls = 0;
  const f = createForwarder({ post: async () => { calls++; throw httpError(400); }, sleep: noSleep, logger: quiet });
  assert.equal((await f.forward('OrderRefunded:9', '/events/order-refunded', {})).status, 'failed');
  assert.equal(calls, 1);
  assert.equal(f.isDelivered('OrderRefunded:9'), false);
});

test('409 Conflict counts as already delivered', async () => {
  const f = createForwarder({ post: async () => { throw httpError(409); }, sleep: noSleep, logger: quiet });
  assert.equal((await f.forward('OrderCreated:5', '/events/order-created', {})).status, 'delivered');
  assert.equal(f.isDelivered('OrderCreated:5'), true);
});

test('concurrent sightings of one event (live + backfill) send a single request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const post = async () => { calls++; await gate; return { data: 'ok' }; };
  const f = createForwarder({ post, sleep: noSleep, logger: quiet });
  const a = f.forward('OrderCreated:11', '/events/order-created', {});
  const b = f.forward('OrderCreated:11', '/events/order-created', {});
  release();
  assert.equal((await a).status, 'delivered');
  assert.equal((await b).status, 'delivered');
  assert.equal(calls, 1);
});

test('events of different types with the same orderId are tracked separately', async () => {
  const seen = [];
  const f = createForwarder({ post: async (path) => { seen.push(path); return {}; }, sleep: noSleep, logger: quiet });
  await f.forward('OrderCreated:2', '/events/order-created', {});
  await f.forward('OrderSettled:2', '/events/order-settled', {});
  assert.deepEqual(seen, ['/events/order-created', '/events/order-settled']);
});

test('isRetryable: network errors, 429 and 5xx only', () => {
  assert.equal(isRetryable(networkError()), true);
  assert.equal(isRetryable(httpError(429)), true);
  assert.equal(isRetryable(httpError(500)), true);
  assert.equal(isRetryable(httpError(404)), false);
  assert.equal(isRetryable(httpError(401)), false);
});
