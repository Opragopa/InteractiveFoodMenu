import { getApps, initializeApp } from "firebase-admin/app";
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
import { paginateLegacyDisplay } from "./legacyDisplay.js";

export {
  createVenueFromHub,
  getBackendHubOverview,
  loginBackendHub,
  revokeVenueSessionsFromHub,
  rotateVenuePinFromHub,
} from "./backendHub.js";

if (!getApps().length) initializeApp();
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
type ClientLogLevel = "info" | "warn" | "error";

function redactLogText(value: unknown, maxLength = 500): string {
  return String(value ?? "")
    .replace(/(pin|secret|token|password)=[^\s&]+/gi, "$1=[redacted]")
    .replace(/#[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}/g, "#[redacted]")
    .slice(0, maxLength);
}

function clientLogDetails(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const details: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 12)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    if (typeof entry === "string") details[key] = redactLogText(entry, 200);
    else if (typeof entry === "number" && Number.isFinite(entry)) details[key] = entry;
    else if (typeof entry === "boolean") details[key] = entry;
  }
  return details;
}

function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[character] ?? character));
}

function foregroundFor(background: string): string {
  const channels = [1, 3, 5].map((index) => parseInt(background.slice(index, index + 2), 16) / 255)
    .map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return luminance > .45 ? "#201f1c" : "#ffffff";
}

/**
 * A no-JavaScript display for old TVs (for example LG webOS 3 / Chromium 38
 * and Samsung Tizen 5 / Chromium 63).
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
  const categories = categorySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as { id: string; name: string; sortOrder?: number }))
    .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
  const items = itemSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as {
    id: string; categoryId: string; name: string; sortOrder?: number; isAvailable?: boolean; priceMinor?: number;
  }));
  const scale = Math.min(1.6, Math.max(0.8, (Number(venue.displayScalePercent) || 100) / 100));
  const pages = paginateLegacyDisplay(categories, items, Math.max(5, Math.floor(19 / scale)), 2);
  const requestedPage = Number.parseInt(String(request.query.page ?? "0"), 10);
  const pageIndex = Number.isFinite(requestedPage) && requestedPage >= 0 && pages.length
    ? requestedPage % pages.length
    : 0;
  const page = pages[pageIndex] ?? [];
  const content = page.map((column) => `<div class="column">${column.map((entry) => entry.kind === "category"
    ? `<h2>${htmlEscape(entry.name)}${entry.repeated ? '<small> · продолжение</small>' : ""}</h2>`
    : `<div class="item${entry.item.isAvailable === false ? " unavailable" : ""}"><span>${htmlEscape(entry.item.name)}</span><b>${(Number(entry.item.priceMinor ?? 0) / 100).toFixed(2).replace(".", ",")} ₽</b></div>`).join("")}</div>`).join("");
  const background = /^#[0-9a-f]{6}$/i.test(String(venue.backgroundColor)) ? String(venue.backgroundColor) : "#f7f4ee";
  const accent = /^#[0-9a-f]{6}$/i.test(String(venue.accentColor)) ? String(venue.accentColor) : "#9c3d24";
  const foreground = foregroundFor(background);
  const duration = Math.min(60, Math.max(5, Number(venue.pageDurationSeconds) || 10));
  const nextPage = pages.length > 1 ? (pageIndex + 1) % pages.length : 0;
  const refresh = pages.length > 1
    ? `${duration};url=/display/${match[1]}.${match[2]}?page=${nextPage}`
    : String(duration);
  response.set("Cache-Control", "no-store, no-cache, must-revalidate").status(200).type("html").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${refresh}"><title>${htmlEscape(venue.name)} — Меню</title><style>
    @font-face{font-family:Onest;src:url('/fonts/onest-variable.ttf') format('truetype');font-weight:100 900;font-display:swap}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;font-family:Onest,Arial,sans-serif;color:${foreground};background:${background}}body{height:100vh;padding:2vh 2.4vw;display:flex;flex-direction:column}h1{flex:0 0 ${7 * scale}vh;max-width:100%;margin:0 0 ${1 * scale}vh;overflow:hidden;color:${accent};font-size:${5.2 * scale}vh;line-height:1.1;white-space:nowrap;text-overflow:ellipsis}main{display:flex;flex:1;min-height:0;overflow:hidden}.column{width:50%;height:100%;overflow:hidden;padding:0 1.5vw}.column+.column{border-left:1px solid ${accent}55}h2{height:${4.4 * scale}vh;margin:0;padding:0 ${.5 * scale}vh;overflow:hidden;color:${accent};font-size:${2.8 * scale}vh;line-height:1.1;white-space:nowrap;text-overflow:ellipsis;border-bottom:${.25 * scale}vh solid ${accent}}h2 small{font-size:.55em;font-weight:400;opacity:.65}.item{height:${4.2 * scale}vh;display:flex;align-items:center;overflow:hidden;font-size:${2.35 * scale}vh;line-height:1.1;white-space:nowrap}.item span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.item b{margin-left:1vw;white-space:nowrap}.item.unavailable{color:#88837d;opacity:.65}.item.unavailable span,.item.unavailable b{text-decoration:line-through;text-decoration-thickness:1px}.empty{width:100%;display:flex;align-items:center;justify-content:center;color:#777;font-size:${4 * scale}vh}footer{height:2vh;flex:0 0 2vh;text-align:right;color:${foreground};opacity:.55;font-size:1.4vh}@media(max-aspect-ratio:4/3){body{padding:2vh 3vw}h1{font-size:${4 * scale}vh}.item{font-size:${2 * scale}vh}}</style></head><body><h1>${htmlEscape(venue.name)}</h1><main>${content || '<div class="empty">Меню пока не заполнено</div>'}</main><footer>${pages.length ? `${pageIndex + 1} / ${pages.length}` : ""}</footer></body></html>`);
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

/** Receives redacted diagnostics from authenticated clients only. */
export const reportClientLog = onCall(callableOptions, async (request) => {
  const auth = request.auth;
  const venueId = typeof auth?.token.venueId === "string" ? auth.token.venueId : null;
  const role = auth?.token.role;
  if (!auth || !venueId || (role !== "staff" && role !== "display")) {
    throw new HttpsError("unauthenticated", "Требуется авторизованный клиент.");
  }
  const event = String(request.data?.event ?? "");
  const level = String(request.data?.level ?? "error") as ClientLogLevel;
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(event) || !["info", "warn", "error"].includes(level)) {
    throw new HttpsError("invalid-argument", "Некорректный диагностический журнал.");
  }
  const message = redactLogText(request.data?.message, 500);
  const details = clientLogDetails(request.data?.details);
  const entry = { event, level, message, details, venueId, role, uid: auth.uid };
  await db.collection("clientLogs").add({ ...entry, createdAt: FieldValue.serverTimestamp() });
  logger[level]("Client diagnostic", entry);
  return { accepted: true };
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
