import { createHash } from "node:crypto";
import { createClient } from "redis";
import { consumeRateLimit, pruneRateLimitBuckets } from "./rateLimit.js";

const WINDOW_MS = 15 * 60_000;
const WINDOW_SECONDS = WINDOW_MS / 1000;
const IP_LIMIT = 12;
const ACCOUNT_LIMIT = 5;

function key(scope: string, kind: string, value: string) {
  return `ifm:auth:${scope}:${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

export function createAuthLimiter(redisUrl?: string) {
  const local = new Map<string, { count: number; resetAt: number }>();
  const redis = redisUrl ? createClient({ url: redisUrl, socket: { reconnectStrategy: retries => Math.min(1000 * (retries + 1), 5000) } }) : null;
  redis?.on("error", () => { /* Authentication fails closed while Redis is unavailable. */ });
  const ready = redis?.connect().catch(() => undefined);

  async function consumeOne(redisKey: string, limit: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    if (!redis) {
      if (local.size > 1000) pruneRateLimitBuckets(local, Date.now());
      return consumeRateLimit(local, redisKey, Date.now(), WINDOW_MS, limit);
    }
    await ready;
    if (!redis.isReady) throw new Error("authentication_limiter_unavailable");
    const replies = await redis.multi().incr(redisKey).expire(redisKey, WINDOW_SECONDS, "NX").exec();
    const count = Number(replies[0]);
    if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
    const ttl = await redis.ttl(redisKey);
    return { allowed: false, retryAfterSeconds: Math.max(1, ttl) };
  }

  return {
    async check(scope: string, ip: string, identity?: string) {
      const ipResult = await consumeOne(key(scope, "ip", ip), IP_LIMIT);
      if (!ipResult.allowed) return ipResult;
      if (identity) return consumeOne(key(scope, "account", identity.toLowerCase()), ACCOUNT_LIMIT);
      return ipResult;
    },
    async close() { if (redis?.isOpen) await redis.quit(); },
    async healthy() { if (!redis) return true; await ready; return redis.isReady; },
  };
}
