export function createRateLimiter({ maxRequests = 120, windowMs = 60_000, now = Date.now } = {}) {
  const buckets = new Map();
  let checks = 0;

  function prune(timestamp) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
  }

  return {
    check(key) {
      const timestamp = now();
      checks += 1;
      if (checks % 1000 === 0) prune(timestamp);

      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= timestamp) {
        bucket = { count: 0, resetAt: timestamp + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      const allowed = bucket.count <= maxRequests;
      return {
        allowed,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - bucket.count),
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000)),
      };
    },
  };
}
