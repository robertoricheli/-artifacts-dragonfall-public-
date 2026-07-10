/**
 * Rate limit básico por socket (Fase 4).
 */
export function createRateLimiter(opts = {}) {
  const max = opts.maxPerWindow ?? 24;
  const windowMs = opts.windowMs ?? 1000;
  /** @type {Map<string, { t: number, n: number }>} */
  const buckets = new Map();

  return function allow(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.t > windowMs) {
      b = { t: now, n: 0 };
      buckets.set(key, b);
    }
    b.n += 1;
    if (b.n > max) return false;
    return true;
  };
}
