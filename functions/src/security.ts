import { promisify } from "node:util";
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, createHash } from "node:crypto";

const scrypt = promisify(nodeScrypt);

export const PIN_PATTERN = /^\d{6}$/;
export const VENUE_CODE_PATTERN = /^[a-z0-9-]{3,32}$/;
export const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export async function hashSecret(secret: string, salt = randomBytes(16).toString("hex")) {
  const derived = (await scrypt(secret, salt, 64)) as Buffer;
  return { salt, hash: derived.toString("hex") };
}

export async function verifySecret(secret: string, salt: string, expectedHex: string) {
  const actual = (await scrypt(secret, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function opaqueId(...parts: string[]) {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
}

export function createDisplayCredentials() {
  return {
    tokenId: randomBytes(12).toString("base64url"),
    secret: randomBytes(32).toString("base64url"),
  };
}

