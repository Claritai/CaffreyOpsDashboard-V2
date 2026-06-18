const NodeCache = require('node-cache');

// TTL per dashboard endpoint, in seconds. Mirrors §8 of CAFFREY-OPS-PHASE-2.md.
const TTL = {
  'client-health': 60,
  'categories': 300,
  'missed': 300,
  'performance': 600,
  'stalled': 1800,
  'it-alerts': 120,
  'drilldown': 60,
};

const cache = new NodeCache({ stdTTL: 60, checkperiod: 30, useClones: false });

/**
 * withCache(key, ttlSeconds, fetchFn, { force }):
 *   If `force` is true OR the key is not cached, runs fetchFn() and stores the result.
 *   Otherwise returns the cached value. Cached value is returned alongside a `cachedAt`
 *   timestamp the caller can surface to the UI.
 */
async function withCache(key, ttlSeconds, fetchFn, { force = false } = {}) {
  if (!force) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }
  const value = await fetchFn();
  const wrapped = { value, cachedAt: new Date().toISOString() };
  cache.set(key, wrapped, ttlSeconds);
  return wrapped;
}

function invalidate(key) { cache.del(key); }
function flushAll() { cache.flushAll(); }

module.exports = { withCache, invalidate, flushAll, TTL };
