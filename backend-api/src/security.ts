import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";

const scrypt = promisify(scryptCallback);

export type SessionRole = "staff" | "display" | "hub";
export type SessionClaims = { role: SessionRole; venueId?: string };

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(secret, salt, 64)) as Buffer;
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    const actual = (await scrypt(secret, salt, expected.length)) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function signSession(claims: SessionClaims, secret: string, expiresIn = "12h"): string {
  return jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: expiresIn as jwt.SignOptions["expiresIn"] });
}

export function verifySession(token: string, secret: string): SessionClaims {
  const claims = jwt.verify(token, secret, { algorithms: ["HS256"] });
  if (typeof claims === "string" || !claims.role || !["staff", "display", "hub"].includes(claims.role)) {
    throw new Error("Invalid session claims.");
  }
  return { role: claims.role as SessionRole, venueId: typeof claims.venueId === "string" ? claims.venueId : undefined };
}
