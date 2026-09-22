import assert from "node:assert/strict";
import test from "node:test";
import { hashSecret, opaqueToken, signSession, verifySecret, verifySession } from "./security.js";

test("secret hashes are salted and verifiable", async () => {
  const first = await hashSecret("123456");
  const second = await hashSecret("123456");
  assert.notEqual(first, second);
  assert.equal(await verifySecret("123456", first), true);
  assert.equal(await verifySecret("654321", first), false);
});

test("sessions preserve role and venue scope", () => {
  const secret = "a".repeat(32);
  const token = signSession({ role: "staff", venueId: "venue-1" }, secret);
  assert.deepEqual(verifySession(token, secret), { role: "staff", venueId: "venue-1" });
});

test("opaque tokens contain enough entropy", () => {
  assert.ok(opaqueToken().length >= 42);
});
