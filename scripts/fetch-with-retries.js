"use strict";

const { setTimeout: sleep } = require("node:timers/promises");

const ATTEMPTS = 3;
const MAX_DELAY_MS = 30000;

function retryDelay(response, attempt, now) {
  const value = response?.headers.get("retry-after");
  if (value != null) {
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value) - now();
    if (Number.isFinite(milliseconds))
      return Math.min(MAX_DELAY_MS, Math.max(0, milliseconds));
  }
  return 1000 * 2 ** (attempt - 1);
}

// The fleet reads hundreds of public manifests. A temporary throttle or
// service failure must be retried, while a missing manifest still means this
// repository is not a package and a persistent error remains visible.
async function fetchWithRetries(url, options = {}, dependencies = {}) {
  const request = dependencies.fetch || globalThis.fetch;
  const pause = dependencies.sleep || sleep;
  const now = dependencies.now || Date.now;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await request(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (attempt === ATTEMPTS || options.signal?.aborted) throw error;
      process.stderr.write(
        `Retrying ${url} after ${error.message} (attempt ${attempt}).\n`,
      );
      await pause(retryDelay(null, attempt, now));
      continue;
    }
    const transient =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    if (!transient || attempt === ATTEMPTS) return response;
    const delay = retryDelay(response, attempt, now);
    // A failed body may reject cancellation too; this cleanup must not prevent
    // the retry of the request that already returned a transient status.
    await response.body?.cancel().catch(() => {});
    process.stderr.write(
      `Retrying ${url} after HTTP ${response.status} (attempt ${attempt}).\n`,
    );
    await pause(delay);
  }
}

module.exports = { fetchWithRetries };
