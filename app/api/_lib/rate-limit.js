/**
 * Small fixed-window limiter for the public Graphviz compute endpoints.
 * State is per process; production deployments that need a hard distributed
 * ceiling should replace this with an atomic shared store.
 */

const buckets = new Map();
const MAX_KEYS = 10_000;

function readLimit(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function prune(now, protectedKeys = new Set()) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now && !protectedKeys.has(key)) buckets.delete(key);
  }
  while (buckets.size > MAX_KEYS) {
    let oldest;
    for (const key of buckets.keys()) {
      if (!protectedKeys.has(key)) {
        oldest = key;
        break;
      }
    }
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

function bucketFor(key, windowMs, now) {
  const current = buckets.get(key);
  return !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;
}

function resultFor(bucket, limit, now) {
  return {
    allowed: bucket.count < limit,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export function consume(key, limit, windowMs, now = Date.now()) {
  if (buckets.size >= MAX_KEYS) prune(now);

  const bucket = bucketFor(key, windowMs, now);
  const result = resultFor(bucket, limit, now);
  if (!result.allowed) return result;

  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > MAX_KEYS) prune(now, new Set([key]));
  return result;
}

export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0].trim();
  return first
    || request.headers.get('x-real-ip')
    || request.headers.get('cf-connecting-ip')
    || 'unknown';
}

export function checkRenderRate(request, now = Date.now()) {
  const ip = clientIp(request);
  const rules = [
    {
      key: `graphviz:minute:${ip}`,
      limit: readLimit('GRAPHVIZ_RATE_LIMIT_PER_MINUTE', 20),
      windowMs: 60_000,
    },
    {
      key: `graphviz:hour:${ip}`,
      limit: readLimit('GRAPHVIZ_RATE_LIMIT_PER_HOUR', 300),
      windowMs: 60 * 60_000,
    },
  ];

  if (buckets.size >= MAX_KEYS) prune(now);
  const checks = rules.map((rule) => {
    const bucket = bucketFor(rule.key, rule.windowMs, now);
    return { ...rule, bucket, result: resultFor(bucket, rule.limit, now) };
  });
  const denied = checks.find((check) => !check.result.allowed);
  if (denied) return denied.result;

  const protectedKeys = new Set();
  for (const check of checks) {
    check.bucket.count += 1;
    buckets.set(check.key, check.bucket);
    protectedKeys.add(check.key);
  }
  if (buckets.size > MAX_KEYS) prune(now, protectedKeys);
  return { allowed: true };
}

export function __reset() {
  buckets.clear();
}
