import assert from "node:assert/strict";
import test from "node:test";
import { consumeRateLimit, pruneRateLimitBuckets } from "./rateLimit.js";

test("rate limiter blocks repeated authentication attempts", () => {
  const buckets = new Map();
  assert.equal(consumeRateLimit(buckets, "1.2.3.4", 0, 60_000, 2).allowed, true);
  assert.equal(consumeRateLimit(buckets, "1.2.3.4", 1, 60_000, 2).allowed, true);
  const blocked = consumeRateLimit(buckets, "1.2.3.4", 2, 60_000, 2);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
});

test("rate limiter resets after its window", () => {
  const buckets = new Map();
  consumeRateLimit(buckets, "1.2.3.4", 0, 1000, 1);
  assert.equal(consumeRateLimit(buckets, "1.2.3.4", 1001, 1000, 1).allowed, true);
  pruneRateLimitBuckets(buckets, 2002);
  assert.equal(buckets.size, 0);
});
