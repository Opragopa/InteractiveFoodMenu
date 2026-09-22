import { timingSafeEqual } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { displayBaseUrl, displayUrl } from "./displayUrl.js";
import {
  createDisplayCredentials,
  hashSecret,
  INSTALLATION_ID_PATTERN,
  opaqueId,
  PIN_PATTERN,
  VENUE_CODE_PATTERN,
} from "./security.js";

if (!getApps().length) initializeApp();
const db = getFirestore();
const hubAccessKey = defineSecret("BACKEND_HUB_ACCESS_KEY");
const enforceAppCheck = process.env.ENFORCE_APP_CHECK !== "false";
const hubOptions = {
  region: "europe-west1",
  enforceAppCheck,
  timeoutSeconds: 30,
} as const;
const hubLoginOptions = { ...hubOptions, secrets: [hubAccessKey] };

const HUB_FUNCTIONS = [
  { name: "loginStaff", area: "Авторизация", access: "Публичная", purpose: "Вход сотрудника по коду точки и PIN" },
  { name: "loginDisplay", area: "Экраны", access: "Публичная", purpose: "Вход ТВ по защищённой ссылке" },
  { name: "createDisplayPairing", area: "Экраны", access: "Публичная", purpose: "Создание одноразового QR-кода" },
  { name: "completeDisplayPairing", area: "Экраны", access: "Публичная", purpose: "Привязка ТВ к точке" },
  { name: "getDisplayPairingStatus", area: "Экраны", access: "Публичная", purpose: "Проверка статуса привязки" },
  { name: "rotateDisplayToken", area: "Экраны", access: "Сотрудник", purpose: "Перевыпуск ссылки экрана" },
  { name: "reportClientLog", area: "Диагностика", access: "Клиент", purpose: "Приём обезличенных ошибок клиентов" },
  { name: "renderDisplay", area: "Экраны", access: "По ссылке", purpose: "HTML для старых телевизоров" },
  { name: "getBackendHubOverview", area: "Хаб", access: "Оператор", purpose: "Состояние платформы и журнал ошибок" },
  { name: "createVenueFromHub", area: "Хаб", access: "Оператор", purpose: "Создание новой точки" },
  { name: "rotateVenuePinFromHub", area: "Хаб", access: "Оператор", purpose: "Смена кода и PIN точки" },
  { name: "revokeVenueSessionsFromHub", area: "Хаб", access: "Оператор", purpose: "Отзыв сессий сотрудников и экранов" },
] as const;

function assertHubAdmin(auth: { token: Record<string, unknown>; uid: string } | undefined) {
  if (!auth || auth.token.role !== "platform_admin") {
    throw new HttpsError("permission-denied", "Требуется доступ оператора платформы.");
  }
  return auth.uid;
}

export function accessKeysMatch(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function asDate(value: unknown) {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

function validateVenueInput(data: unknown) {
  const input = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const venueId = String(input.venueId ?? "").trim().toLowerCase();
  const venueCode = String(input.venueCode ?? "").trim().toLowerCase();
  const pin = String(input.pin ?? "");
  const name = String(input.name ?? "").trim();
  if (!VENUE_CODE_PATTERN.test(venueId) || !VENUE_CODE_PATTERN.test(venueCode) || !PIN_PATTERN.test(pin) || !name || name.length > 80) {
    throw new HttpsError("invalid-argument", "Проверьте ID, код точки, название и шестизначный PIN.");
  }
  return { venueId, venueCode, pin, name };
}

function auditRecord(action: string, actorUid: string, venueId: string, details: Record<string, unknown> = {}) {
  return {
    action,
    actorUid,
    venueId,
    details,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function logAudit(action: string, actorUid: string, venueId: string, details: Record<string, unknown> = {}) {
  logger.info("Backend hub action", { action, actorUid, venueId, ...details });
}

export const loginBackendHub = onCall(hubLoginOptions, async (request) => {
  const accessKey = String(request.data?.accessKey ?? "");
  const installationId = String(request.data?.installationId ?? "");
  const expected = hubAccessKey.value();
  if (!INSTALLATION_ID_PATTERN.test(installationId) || expected.length < 24 || !accessKeysMatch(accessKey, expected)) {
    logger.warn("Backend hub login rejected", { installation: opaqueId(installationId).slice(0, 16) });
    throw new HttpsError("unauthenticated", "Неверный ключ оператора.");
  }
  const uid = `platform-admin-${opaqueId(installationId).slice(0, 32)}`;
  const customToken = await getAuth().createCustomToken(uid, { role: "platform_admin" });
  logger.info("Backend hub login accepted", { uid });
  return { customToken };
});

export const getBackendHubOverview = onCall(hubOptions, async (request) => {
  assertHubAdmin(request.auth);
  const [venues, access, venueCount, itemCount, categoryCount, activeDisplayCount, logs, auditLogs] = await Promise.all([
    db.collection("venues").orderBy("name").limit(200).get(),
    db.collection("venueAccess").limit(200).get(),
    db.collection("venues").count().get(),
    db.collection("items").count().get(),
    db.collection("categories").count().get(),
    db.collection("displayTokens").where("active", "==", true).count().get(),
    db.collection("clientLogs").orderBy("createdAt", "desc").limit(30).get(),
    db.collection("adminAuditLogs").orderBy("createdAt", "desc").limit(20).get(),
  ]);
  const accessByVenue = new Map(access.docs.map((entry) => [entry.id, entry.data()]));
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      venues: venueCount.data().count,
      categories: categoryCount.data().count,
      items: itemCount.data().count,
      activeDisplays: activeDisplayCount.data().count,
    },
    venues: venues.docs.map((entry) => ({
      id: entry.id,
      name: String(entry.get("name") ?? entry.id),
      code: String(accessByVenue.get(entry.id)?.currentVenueCode ?? ""),
      staffVersion: Number(entry.get("staffVersion") ?? 0),
      displayVersion: Number(entry.get("displayVersion") ?? 0),
      updatedAt: asDate(entry.get("updatedAt")),
    })),
    functions: HUB_FUNCTIONS,
    clientLogs: logs.docs.map((entry) => ({
      id: entry.id,
      venueId: String(entry.get("venueId") ?? ""),
      role: String(entry.get("role") ?? ""),
      level: String(entry.get("level") ?? "error"),
      event: String(entry.get("event") ?? "unknown"),
      message: String(entry.get("message") ?? "").slice(0, 500),
      createdAt: asDate(entry.get("createdAt")),
    })),
    auditLogs: auditLogs.docs.map((entry) => ({
      id: entry.id,
      action: String(entry.get("action") ?? "unknown"),
      venueId: String(entry.get("venueId") ?? ""),
      createdAt: asDate(entry.get("createdAt")),
    })),
  };
});

export const createVenueFromHub = onCall(hubOptions, async (request) => {
  const actorUid = assertHubAdmin(request.auth);
  const { venueId, venueCode, pin, name } = validateVenueInput(request.data);
  const [venueSnapshot, codeSnapshot] = await Promise.all([
    db.collection("venues").doc(venueId).get(),
    db.collection("venueCodes").doc(venueCode).get(),
  ]);
  if (venueSnapshot.exists) throw new HttpsError("already-exists", "Точка с таким ID уже существует.");
  if (codeSnapshot.exists) throw new HttpsError("already-exists", "Код точки уже используется.");

  const [pinHash, credentials] = await Promise.all([hashSecret(pin), Promise.resolve(createDisplayCredentials())]);
  const displayHash = await hashSecret(credentials.secret);
  const batch = db.batch();
  batch.create(db.collection("venues").doc(venueId), {
    name,
    currency: "RUB",
    backgroundColor: "#F7F4EE",
    accentColor: "#9C3D24",
    logoPath: "",
    pageDurationSeconds: 10,
    displayScalePercent: 100,
    displayVersion: 1,
    staffVersion: 1,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actorUid,
  });
  batch.create(db.collection("venueCodes").doc(venueCode), {
    venueId,
    pinSalt: pinHash.salt,
    pinHash: pinHash.hash,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.create(db.collection("displayTokens").doc(credentials.tokenId), {
    venueId,
    secretSalt: displayHash.salt,
    secretHash: displayHash.hash,
    version: 1,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.create(db.collection("venueAccess").doc(venueId), {
    currentVenueCode: venueCode,
    currentDisplayTokenId: credentials.tokenId,
  });
  batch.create(db.collection("adminAuditLogs").doc(), auditRecord("venue_created", actorUid, venueId, { venueCode }));
  await batch.commit();
  logAudit("venue_created", actorUid, venueId, { venueCode });
  return { venueId, displayUrl: displayUrl(credentials.tokenId, credentials.secret, displayBaseUrl()) };
});

export const rotateVenuePinFromHub = onCall(hubOptions, async (request) => {
  const actorUid = assertHubAdmin(request.auth);
  const { venueId, venueCode, pin } = validateVenueInput({ ...request.data, name: "placeholder" });
  const pinHash = await hashSecret(pin);
  await db.runTransaction(async (transaction) => {
    const venueRef = db.collection("venues").doc(venueId);
    const accessRef = db.collection("venueAccess").doc(venueId);
    const codeRef = db.collection("venueCodes").doc(venueCode);
    const [venue, access, code] = await Promise.all([
      transaction.get(venueRef), transaction.get(accessRef), transaction.get(codeRef),
    ]);
    if (!venue.exists) throw new HttpsError("not-found", "Точка не найдена.");
    if (code.exists && code.get("venueId") !== venueId) throw new HttpsError("already-exists", "Код точки уже используется.");
    const previousCode = access.get("currentVenueCode") as string | undefined;
    if (previousCode && previousCode !== venueCode) transaction.delete(db.collection("venueCodes").doc(previousCode));
    transaction.set(codeRef, { venueId, pinSalt: pinHash.salt, pinHash: pinHash.hash, updatedAt: FieldValue.serverTimestamp() });
    transaction.set(accessRef, { currentVenueCode: venueCode }, { merge: true });
    transaction.update(venueRef, {
      staffVersion: Number(venue.get("staffVersion") ?? 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    });
    transaction.create(db.collection("adminAuditLogs").doc(), auditRecord("venue_pin_rotated", actorUid, venueId, { venueCode }));
  });
  logAudit("venue_pin_rotated", actorUid, venueId, { venueCode });
  return { updated: true };
});

export const revokeVenueSessionsFromHub = onCall(hubOptions, async (request) => {
  const actorUid = assertHubAdmin(request.auth);
  const venueId = String(request.data?.venueId ?? "").trim().toLowerCase();
  const scope = String(request.data?.scope ?? "all");
  if (!VENUE_CODE_PATTERN.test(venueId) || !["staff", "display", "all"].includes(scope)) {
    throw new HttpsError("invalid-argument", "Некорректная точка или область отзыва.");
  }
  await db.runTransaction(async (transaction) => {
    const venueRef = db.collection("venues").doc(venueId);
    const accessRef = db.collection("venueAccess").doc(venueId);
    const [venue, access] = await Promise.all([transaction.get(venueRef), transaction.get(accessRef)]);
    if (!venue.exists) throw new HttpsError("not-found", "Точка не найдена.");
    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    if (scope === "staff" || scope === "all") update.staffVersion = Number(venue.get("staffVersion") ?? 0) + 1;
    if (scope === "display" || scope === "all") {
      update.displayVersion = Number(venue.get("displayVersion") ?? 0) + 1;
      const tokenId = access.get("currentDisplayTokenId") as string | undefined;
      if (tokenId) transaction.update(db.collection("displayTokens").doc(tokenId), { active: false });
    }
    transaction.update(venueRef, update);
    transaction.create(db.collection("adminAuditLogs").doc(), auditRecord("venue_sessions_revoked", actorUid, venueId, { scope }));
  });
  logAudit("venue_sessions_revoked", actorUid, venueId, { scope });
  return { revoked: true };
});
