import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import {
  createDisplayCredentials,
  hashSecret,
  INSTALLATION_ID_PATTERN,
  opaqueId,
  PIN_PATTERN,
  VENUE_CODE_PATTERN,
  verifySecret,
} from "./security.js";
import { displayBaseUrl, displayUrl, normalizeDisplayBaseUrl } from "./displayUrl.js";

initializeApp();
const db = getFirestore();
const enforceAppCheck = process.env.ENFORCE_APP_CHECK !== "false";
const callableOptions = { region: "europe-west1", enforceAppCheck, timeoutSeconds: 30 } as const;
// TV browsers on older webOS versions cannot execute reCAPTCHA Enterprise.
// These calls rely on one-time secrets and Firebase Auth instead of App Check.
const displayCallableOptions = { region: "europe-west1", enforceAppCheck: false, timeoutSeconds: 30 } as const;
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;

type StaffCode = { venueId: string; pinSalt: string; pinHash: string };
type DisplayToken = {
  venueId: string;
  secretSalt: string;
  secretHash: string;
  version: number;
  active: boolean;
};
type MenuDoc = { id: string; [key: string]: unknown };

function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[character] ?? character));
}

/**
 * A no-JavaScript display for old TVs (for example LG webOS 3 / Chromium 38).
 * The TV only receives static HTML and refreshes it periodically.
 */
export const renderDisplay = onRequest({ region: "europe-west1", timeoutSeconds: 30 }, async (request, response) => {
  const match = /^\/display\/([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})\/?$/.exec(request.path);
  if (!match) { response.status(404).type("html").send("<h1>Ссылка экрана недействительна</h1>"); return; }
  const tokenSnapshot = await db.collection("displayTokens").doc(match[1]).get();
  const token = tokenSnapshot.data() as DisplayToken | undefined;
  if (!token || !token.active || !(await verifySecret(match[2], token.secretSalt, token.secretHash))) {
    response.status(401).type("html").send("<h1>Ссылка экрана недействительна или была перевыпущена.</h1>"); return;
  }
  const venueSnapshot = await db.collection("venues").doc(token.venueId).get();
  if (!venueSnapshot.exists || Number(venueSnapshot.get("displayVersion")) !== token.version) {
    response.status(401).type("html").send("<h1>Ссылка экрана была перевыпущена.</h1>"); return;
  }
  const venue = venueSnapshot.data() ?? {};
  const [categorySnapshot, itemSnapshot] = await Promise.all([
    db.collection("categories").where("venueId", "==", token.venueId).get(),
    db.collection("items").where("venueId", "==", token.venueId).get(),
  ]);
  const categories = categorySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as MenuDoc).sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
  const items = itemSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as MenuDoc).filter((item) => item.isAvailable !== false).sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
  const byCategory = new Map(categories.map((category) => [category.id, { category, items: items.filter((item) => item.categoryId === category.id) }]));
  const sections = categories.map(({ id, name }) => {
    const group = byCategory.get(id);
    if (!group || !group.items.length) return "";
    return `<section><h2>${htmlEscape(name)}</h2>${group.items.map((item) => `<div class="item"><span>${htmlEscape(item.name)}</span><b>${(Number(item.priceMinor ?? 0) / 100).toFixed(2).replace(".", ",")} ₽</b></div>`).join("")}</section>`;
  }).join("");
  const background = /^#[0-9a-f]{6}$/i.test(String(venue.backgroundColor)) ? String(venue.backgroundColor) : "#f7f4ee";
  const accent = /^#[0-9a-f]{6}$/i.test(String(venue.accentColor)) ? String(venue.accentColor) : "#9c3d24";
  response.set("Cache-Control", "no-store, no-cache, must-revalidate").status(200).type("html").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>${htmlEscape(venue.name)} — Меню</title><style>
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Arial,sans-serif;color:#201f1c;background:${background}}body{padding:32px 48px}h1{margin:0 0 28px;color:${accent};font-size:clamp(36px,4vw,72px);line-height:1.05}main{columns:2 420px;column-gap:56px}section{break-inside:avoid;margin:0 0 28px}h2{margin:0 0 8px;padding:0 0 6px;color:${accent};font-size:clamp(24px,2vw,36px);border-bottom:3px solid ${accent}}.item{display:flex;align-items:flex-end;gap:12px;min-height:42px;padding:5px 0;font-size:clamp(20px,1.7vw,30px);line-height:1.2}.item span{flex:1;overflow-wrap:break-word}.item b{white-space:nowrap} .empty{font-size:32px;color:#777}</style></head><body><h1>${htmlEscape(venue.name)}</h1><main>${sections || '<div class="empty">Меню пока не заполнено</div>'}</main></body></html>`);
});

async function assertNotRateLimited(key: string) {
  const ref = db.collection("loginAttempts").doc(key);
  const snapshot = await ref.get();
  if (!snapshot.exists) return;
  const data = snapshot.data()!;
  const startedAt = data.startedAt?.toMillis?.() ?? 0;
  if (Date.now() - startedAt < WINDOW_MS && Number(data.failures) >= MAX_FAILURES) {
    throw new HttpsError("resource-exhausted", "Слишком много попыток. Повторите через 5 минут.");
  }
}

async function recordFailure(key: string) {
  const ref = db.collection("loginAttempts").doc(key);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data();
    const startedAt = data?.startedAt?.toMillis?.() ?? 0;
    if (!snapshot.exists || Date.now() - startedAt >= WINDOW_MS) {
      transaction.set(ref, { failures: 1, startedAt: FieldValue.serverTimestamp() });
    } else {
      transaction.update(ref, { failures: FieldValue.increment(1) });
    }
  });
}

export const loginStaff = onCall(callableOptions, async (request) => {
  const venueCode = String(request.data?.venueCode ?? "").trim().toLowerCase();
  const pin = String(request.data?.pin ?? "");
  const installationId = String(request.data?.installationId ?? "");
  if (!VENUE_CODE_PATTERN.test(venueCode) || !PIN_PATTERN.test(pin) || !INSTALLATION_ID_PATTERN.test(installationId)) {
    throw new HttpsError("invalid-argument", "Проверьте код заведения и шестизначный PIN.");
  }

  const attemptKey = opaqueId("staff", venueCode, installationId);
  await assertNotRateLimited(attemptKey);
  const codeSnapshot = await db.collection("venueCodes").doc(venueCode).get();
  const code = codeSnapshot.data() as StaffCode | undefined;
  if (!code || !(await verifySecret(pin, code.pinSalt, code.pinHash))) {
    await recordFailure(attemptKey);
    logger.warn("Staff login rejected", { venueCode, installation: opaqueId(installationId) });
    throw new HttpsError("unauthenticated", "Неверный код заведения или PIN.");
  }

  const venueSnapshot = await db.collection("venues").doc(code.venueId).get();
  if (!venueSnapshot.exists) throw new HttpsError("not-found", "Заведение не настроено.");
  const staffVersion = Number(venueSnapshot.get("staffVersion") ?? 1);
  const uid = `staff-${opaqueId(code.venueId, installationId).slice(0, 32)}`;
  const customToken = await getAuth().createCustomToken(uid, {
    role: "staff",
    venueId: code.venueId,
    staffVersion,
  });
  await db.collection("loginAttempts").doc(attemptKey).delete().catch(() => undefined);
  logger.info("Staff login accepted", { venueId: code.venueId, uid });
  return { customToken, venueId: code.venueId };
});

export const loginDisplay = onCall(displayCallableOptions, async (request) => {
  const tokenId = String(request.data?.tokenId ?? "");
  const secret = String(request.data?.secret ?? "");
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(tokenId) || !/^[A-Za-z0-9_-]{32,80}$/.test(secret)) {
    throw new HttpsError("invalid-argument", "Некорректная ссылка экрана.");
  }
  const attemptKey = opaqueId("display", tokenId);
  await assertNotRateLimited(attemptKey);
  const tokenSnapshot = await db.collection("displayTokens").doc(tokenId).get();
  const token = tokenSnapshot.data() as DisplayToken | undefined;
  if (!token || !token.active || !(await verifySecret(secret, token.secretSalt, token.secretHash))) {
    await recordFailure(attemptKey);
    logger.warn("Display login rejected", { tokenId });
    throw new HttpsError("unauthenticated", "Ссылка экрана недействительна.");
  }
  const venueSnapshot = await db.collection("venues").doc(token.venueId).get();
  if (!venueSnapshot.exists || Number(venueSnapshot.get("displayVersion")) !== token.version) {
    throw new HttpsError("permission-denied", "Ссылка экрана была перевыпущена.");
  }
  const uid = `display-${token.venueId}-v${token.version}`;
  const customToken = await getAuth().createCustomToken(uid, {
    role: "display",
    venueId: token.venueId,
    displayVersion: token.version,
  });
  await db.collection("loginAttempts").doc(attemptKey).delete().catch(() => undefined);
  return { customToken, venueId: token.venueId };
});

export const rotateDisplayToken = onCall(callableOptions, async (request) => {
  const auth = request.auth;
  if (!auth || auth.token.role !== "staff" || typeof auth.token.venueId !== "string") {
    throw new HttpsError("permission-denied", "Требуется вход сотрудника.");
  }
  let requestedBaseUrl: string | undefined;
  try {
    requestedBaseUrl = normalizeDisplayBaseUrl(request.data?.displayBaseUrl);
  } catch (error) {
    throw new HttpsError("invalid-argument", error instanceof Error ? error.message : "Некорректный адрес экрана.");
  }
  const venueId = auth.token.venueId;
  const credentials = createDisplayCredentials();
  const secretHash = await hashSecret(credentials.secret);
  let nextVersion = 1;
  await db.runTransaction(async (transaction) => {
    const venueRef = db.collection("venues").doc(venueId);
    const accessRef = db.collection("venueAccess").doc(venueId);
    const venueSnapshot = await transaction.get(venueRef);
    if (!venueSnapshot.exists) throw new HttpsError("not-found", "Заведение не найдено.");
    if (Number(auth.token.staffVersion) !== Number(venueSnapshot.get("staffVersion"))) {
      throw new HttpsError("permission-denied", "Сессия устарела. Войдите с новым PIN.");
    }
    nextVersion = Number(venueSnapshot.get("displayVersion") ?? 0) + 1;
    const accessSnapshot = await transaction.get(accessRef);
    const previousId = accessSnapshot.get("currentDisplayTokenId") as string | undefined;
    if (previousId) transaction.update(db.collection("displayTokens").doc(previousId), { active: false });
    transaction.set(db.collection("displayTokens").doc(credentials.tokenId), {
      venueId,
      secretSalt: secretHash.salt,
      secretHash: secretHash.hash,
      version: nextVersion,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(accessRef, { currentDisplayTokenId: credentials.tokenId }, { merge: true });
    transaction.update(venueRef, {
      displayVersion: nextVersion,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.uid,
    });
  });
  const url = displayUrl(credentials.tokenId, credentials.secret, requestedBaseUrl ?? displayBaseUrl());
  logger.info("Display token rotated", { venueId, version: nextVersion });
  return { displayUrl: url, version: nextVersion };
});

// Pairing flow for a TV that has no staff credentials. The TV receives a
// short-lived one-time token; the phone completes the pairing after checking
// the venue code and PIN.
export const createDisplayPairing = onCall(displayCallableOptions, async (request) => {
  let pairingBaseUrl: string;
  try {
    pairingBaseUrl = normalizeDisplayBaseUrl(request.data?.displayBaseUrl) ?? displayBaseUrl();
  } catch (error) {
    throw new HttpsError("invalid-argument", error instanceof Error ? error.message : "Некорректный адрес экрана.");
  }
  const pairing = createDisplayCredentials();
  const pairingHash = await hashSecret(pairing.secret);
  await db.collection("displayPairings").doc(pairing.tokenId).set({
    secretSalt: pairingHash.salt,
    secretHash: pairingHash.hash,
    status: "pending",
    displayBaseUrl: pairingBaseUrl,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    createdAt: FieldValue.serverTimestamp(),
  });
  return { pairingToken: `${pairing.tokenId}.${pairing.secret}`, displayBaseUrl: pairingBaseUrl, expiresInSeconds: 300 };
});

export const completeDisplayPairing = onCall(displayCallableOptions, async (request) => {
  const pairingToken = String(request.data?.pairingToken ?? "");
  const venueCode = String(request.data?.venueCode ?? "").trim().toLowerCase();
  const pin = String(request.data?.pin ?? "");
  const match = /^([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})$/.exec(pairingToken);
  if (!match || !VENUE_CODE_PATTERN.test(venueCode) || !PIN_PATTERN.test(pin)) {
    throw new HttpsError("invalid-argument", "Некорректные данные подключения.");
  }
  const pairingRef = db.collection("displayPairings").doc(match[1]);
  const pairingSnapshot = await pairingRef.get();
  const pairing = pairingSnapshot.data();
  if (!pairing || pairing.status !== "pending" || pairing.expiresAt?.toDate?.() < new Date() || !(await verifySecret(match[2], pairing.secretSalt, pairing.secretHash))) {
    throw new HttpsError("unauthenticated", "QR-код подключения недействителен или истёк.");
  }
  const codeSnapshot = await db.collection("venueCodes").doc(venueCode).get();
  const code = codeSnapshot.data() as StaffCode | undefined;
  if (!code || !(await verifySecret(pin, code.pinSalt, code.pinHash))) {
    throw new HttpsError("unauthenticated", "Неверный код заведения или PIN.");
  }
  const credentials = createDisplayCredentials();
  const secretHash = await hashSecret(credentials.secret);
  const venueSnapshot = await db.collection("venues").doc(code.venueId).get();
  const version = Number(venueSnapshot.get("displayVersion") ?? 1);
  const url = displayUrl(credentials.tokenId, credentials.secret, typeof pairing.displayBaseUrl === "string" ? pairing.displayBaseUrl : displayBaseUrl());
  await db.runTransaction(async (transaction) => {
    transaction.set(db.collection("displayTokens").doc(credentials.tokenId), {
      venueId: code.venueId, secretSalt: secretHash.salt, secretHash: secretHash.hash,
      version, active: true, createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(pairingRef, {
      status: "used", usedAt: FieldValue.serverTimestamp(), venueId: code.venueId,
      displayUrl: url,
    });
  });
  return { displayUrl: url, venueId: code.venueId };
});

export const getDisplayPairingStatus = onCall(displayCallableOptions, async (request) => {
  const pairingToken = String(request.data?.pairingToken ?? "");
  const match = /^([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})$/.exec(pairingToken);
  if (!match) throw new HttpsError("invalid-argument", "Некорректный pairing-токен.");
  const snapshot = await db.collection("displayPairings").doc(match[1]).get();
  const pairing = snapshot.data();
  if (!pairing || !(await verifySecret(match[2], pairing.secretSalt, pairing.secretHash))) {
    throw new HttpsError("unauthenticated", "QR-код подключения недействителен.");
  }
  if (pairing.expiresAt?.toDate?.() < new Date() && pairing.status === "pending") return { status: "expired" };
  return { status: pairing.status, displayUrl: pairing.displayUrl ?? null };
});
