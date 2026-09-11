import test from "node:test";
import assert from "node:assert/strict";
import { createDisplayCredentials, hashSecret, opaqueId, verifySecret } from "./security.js";

test("scrypt hash accepts only the original secret", async () => {
  const stored = await hashSecret("123456");
  assert.equal(await verifySecret("123456", stored.salt, stored.hash), true);
  assert.equal(await verifySecret("654321", stored.salt, stored.hash), false);
});

test("opaque ids and display credentials are stable/unique enough", () => {
  assert.equal(opaqueId("a", "b"), opaqueId("a", "b"));
  const first = createDisplayCredentials();
  const second = createDisplayCredentials();
  assert.notEqual(first.tokenId, second.tokenId);
  assert.match(first.secret, /^[A-Za-z0-9_-]+$/);
});

