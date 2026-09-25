export type RateLimitBucket = { count: number; resetAt: number };

export function consumeRateLimit(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  now: number,
  windowMs: number,
  maxAttempts: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= maxAttempts) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function pruneRateLimitBuckets(buckets: Map<string, RateLimitBucket>, now: number): void {
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}
