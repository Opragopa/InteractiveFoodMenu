import { initializeApp, applicationDefault } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { displayUrl } from "./displayUrl.js";
import { createDisplayCredentials, hashSecret, PIN_PATTERN, VENUE_CODE_PATTERN } from "./security.js";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const venueId = argument("id") ?? "main";
  const code = (argument("code") ?? "").trim().toLowerCase();
  const pin = argument("pin") ?? "";
  const name = (argument("name") ?? "Меню в наличии").trim();
  const demoMenu = argument("demo-menu") === "true";
  const projectId = argument("project") ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!VENUE_CODE_PATTERN.test(code) || !PIN_PATTERN.test(pin) || !name) {
    throw new Error("Usage: npm run seed -- --project=... --id=main --code=my-cafe --pin=123456 --name=Кафе");
  }

  // Make the local setup command explicit and safe: without this guard the
  // Admin SDK falls back to production and asks for Google Application Default
  // Credentials (ADC), which is not needed for the emulator workflow.
  if (process.env.USE_FIREBASE_EMULATORS === "true" && !process.env.FIRESTORE_EMULATOR_HOST) {
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "Seed остановлен: локально задайте USE_FIREBASE_EMULATORS=true (эмулятор Firestore), " +
      "либо для production задайте GOOGLE_APPLICATION_CREDENTIALS."
    );
  }

  initializeApp(process.env.FIRESTORE_EMULATOR_HOST
    ? { projectId }
    : { credential: applicationDefault(), projectId });
  const db = getFirestore();
  const venueRef = db.collection("venues").doc(venueId);
  const existing = await venueRef.get();
  const accessRef = db.collection("venueAccess").doc(venueId);
  const existingAccess = await accessRef.get();
  const staffVersion = Number(existing.get("staffVersion") ?? 0) + 1;
  const currentDisplayVersion = Number(existing.get("displayVersion") ?? 0);
  const pinHash = await hashSecret(pin);
  const credentials = createDisplayCredentials();
  const displayHash = await hashSecret(credentials.secret);
  const displayVersion = currentDisplayVersion + 1;

  const batch = db.batch();
  const previousTokenId = existingAccess.get("currentDisplayTokenId") as string | undefined;
  const previousCode = existingAccess.get("currentVenueCode") as string | undefined;
  if (previousTokenId) batch.update(db.collection("displayTokens").doc(previousTokenId), { active: false });
  if (previousCode && previousCode !== code) batch.delete(db.collection("venueCodes").doc(previousCode));
  batch.set(venueRef, {
    name,
    currency: "RUB",
    backgroundColor: "#F7F4EE",
    accentColor: "#9C3D24",
    logoPath: "",
    pageDurationSeconds: 10,
    displayVersion,
    staffVersion,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: "setup",
  }, { merge: true });
  batch.set(db.collection("venueCodes").doc(code), {
    venueId,
    pinSalt: pinHash.salt,
    pinHash: pinHash.hash,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection("displayTokens").doc(credentials.tokenId), {
    venueId,
    secretSalt: displayHash.salt,
    secretHash: displayHash.hash,
    version: displayVersion,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(accessRef, { currentDisplayTokenId: credentials.tokenId, currentVenueCode: code });

  if (demoMenu) {
    const categories = [
      { id: "demo-coffee", name: "Кофе", sortOrder: 0 },
      { id: "demo-desserts", name: "Десерты", sortOrder: 1 },
    ];
    categories.forEach((category) => {
      batch.set(db.collection("categories").doc(category.id), {
        venueId,
        name: category.name,
        sortOrder: category.sortOrder,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: "setup",
      });
    });
    const items = [
      { id: "demo-espresso", categoryId: "demo-coffee", name: "Эспрессо", priceMinor: 18000, sortOrder: 0 },
      { id: "demo-cappuccino", categoryId: "demo-coffee", name: "Капучино", priceMinor: 26000, sortOrder: 1 },
      { id: "demo-cheesecake", categoryId: "demo-desserts", name: "Чизкейк", priceMinor: 32000, sortOrder: 0 },
      { id: "demo-croissant", categoryId: "demo-desserts", name: "Круассан", priceMinor: 22000, sortOrder: 1 },
    ];
    items.forEach((item) => {
      batch.set(db.collection("items").doc(item.id), {
        venueId,
        categoryId: item.categoryId,
        name: item.name,
        priceMinor: item.priceMinor,
        sortOrder: item.sortOrder,
        isAvailable: true,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: "setup",
      });
    });
  }
  await batch.commit();
  process.stdout.write(`Venue ${venueId} configured.\nDisplay URL: ${displayUrl(credentials.tokenId, credentials.secret)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
