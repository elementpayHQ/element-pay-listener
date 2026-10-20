/**
 * Forwards contract events to the backend at most once per event key.
 *
 * An event is only remembered as delivered after the backend accepts it.
 * Transient failures (network errors, 429, 5xx) are retried with exponential
 * backoff; if every attempt fails the key is left unmarked, so the same event
 * arriving again (live subscription or backfill) is forwarded again instead of
 * being dropped.
 */

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

function isRetryable(err) {
  const status = err && err.response && err.response.status;
  if (!status) return true; // network error, timeout, DNS, connection reset
  return status === 429 || status >= 500;
}

function isAlreadyAccepted(err) {
  // The backend answering 409 Conflict means it already has this event.
  return Boolean(err && err.response && err.response.status === 409);
}

function createForwarder({
  post,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
}) {
  const delivered = new Set();
  const inFlight = new Map();

  async function deliver(key, path, payload) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await post(path, payload);
        delivered.add(key);
        return { status: 'delivered', response: res };
      } catch (err) {
        if (isAlreadyAccepted(err)) {
          delivered.add(key);
          return { status: 'delivered', response: err.response };
        }
        const status = err && err.response ? err.response.status : 'network';
        if (!isRetryable(err) || attempt >= retryDelaysMs.length) {
          logger.error(`❌ Forwarding ${key} to ${path} failed (${status}); will retry if the event is seen again`);
          if (err && err.response) logger.error('📨 Response data:', err.response.data);
          logger.error('📦 Payload:', payload);
          return { status: 'failed', error: err };
        }
        const delay = retryDelaysMs[attempt];
        logger.warn(`🔁 Forwarding ${key} failed (${status}); retry ${attempt + 1}/${retryDelaysMs.length} in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
  }

  /**
   * @param {string} key   unique event key, e.g. "OrderCreated:42"
   * @param {string} path  backend path, e.g. "/events/order-created"
   * @param {object} payload
   */
  async function forward(key, path, payload) {
    if (delivered.has(key)) return { status: 'duplicate' };
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = deliver(key, path, payload).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  return { forward, isDelivered: (key) => delivered.has(key) };
}

module.exports = { createForwarder, isRetryable, DEFAULT_RETRY_DELAYS_MS };
