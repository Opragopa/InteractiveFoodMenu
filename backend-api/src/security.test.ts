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

test("secret verification rejects malformed encodings", async () => {
  assert.equal(await verifySecret("123456", ""), false);
  assert.equal(await verifySecret("123456", "bcrypt:salt:hash"), false);
  assert.equal(await verifySecret("123456", "scrypt::hash"), false);
  assert.equal(await verifySecret("123456", "scrypt:salt:"), false);
  assert.equal(await verifySecret("123456", "scrypt:not-base64:not-base64"), false);
});

test("sessions preserve role and venue scope", () => {
  const secret = "a".repeat(32);
  const token = signSession({ role: "staff", venueId: "venue-1", version: 3, displayTokenId: "display-1" }, secret);
  assert.deepEqual(verifySession(token, secret), { role: "staff", venueId: "venue-1", version: 3, displayTokenId: "display-1" });
  assert.throws(() => verifySession(signSession({ role: "staff" }, secret, "1ms"), "wrong-secret"));
});

test("sessions reject unsupported roles and preserve expiry", () => {
  const secret = "b".repeat(32);
  const invalidRole = jwtToken({ role: "admin" }, secret);
  assert.throws(() => verifySession(invalidRole, secret), /Invalid session claims/);
  const expired = signSession({ role: "display" }, secret, "-1s");
  assert.throws(() => verifySession(expired, secret));
});

test("opaque tokens contain enough entropy", () => {
  assert.ok(opaqueToken().length >= 42);
});

function jwtToken(claims: Record<string, unknown>, secret: string): string {
  return signSession(claims as never, secret);
}
