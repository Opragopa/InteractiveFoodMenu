import test, { after } from "node:test";
import assert from "node:assert/strict";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, serverTimestamp, setDoc, terminate, updateDoc } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const app = initializeApp({ projectId: "demo-interactive-menu", apiKey: "demo-key", appId: "demo-app" }, "e2e");
const auth = getAuth(app);
const firestore = getFirestore(app);
const functions = getFunctions(app, "europe-west1");
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
connectFunctionsEmulator(functions, "127.0.0.1", 5001);

after(async () => {
  await signOut(auth).catch(() => undefined);
  await terminate(firestore);
  await deleteApp(app);
});

test("staff to display flow works and display remains read-only", async () => {
  const loginStaff = httpsCallable(functions, "loginStaff");
  await assert.rejects(
    () => loginStaff({ venueCode: "my-cafe", pin: "000000", installationId: "integration-device" }),
    (error: unknown) => String((error as { code?: string }).code).includes("unauthenticated"),
  );
  const login = await loginStaff({ venueCode: "my-cafe", pin: "123456", installationId: "integration-device" });
  const staffData = login.data as { customToken: string; venueId: string };
  assert.equal(staffData.venueId, "main");
  await signInWithCustomToken(auth, staffData.customToken);

  await setDoc(doc(firestore, "categories", "food"), {
    venueId: "main", name: "Кухня", sortOrder: 0, updatedAt: serverTimestamp(), updatedBy: auth.currentUser!.uid,
  });
  await setDoc(doc(firestore, "items", "soup"), {
    venueId: "main", categoryId: "food", name: "Суп", priceMinor: 25000,
    sortOrder: 0, isAvailable: true, updatedAt: serverTimestamp(), updatedBy: auth.currentUser!.uid,
  });

  const lanBaseUrl = "http://192.168.0.183:5173";
  const rotate = httpsCallable<{ displayBaseUrl: string }, { displayUrl: string }>(functions, "rotateDisplayToken");
  const rotated = (await rotate({ displayBaseUrl: lanBaseUrl })).data;
  assert.ok(rotated.displayUrl.startsWith(`${lanBaseUrl}/#`));
  const credentials = rotated.displayUrl.match(/#([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  assert.ok(credentials);
  await signOut(auth);

  const loginDisplay = httpsCallable(functions, "loginDisplay");
  const display = (await loginDisplay({ tokenId: credentials[1], secret: credentials[2] })).data as { customToken: string };
  await signInWithCustomToken(auth, display.customToken);
  assert.equal((await getDoc(doc(firestore, "items", "soup"))).data()?.name, "Суп");
  await assert.rejects(() => updateDoc(doc(firestore, "items", "soup"), { isAvailable: false }));

  const createPairing = httpsCallable<{ displayBaseUrl: string }, { pairingToken: string; displayBaseUrl: string }>(functions, "createDisplayPairing");
  const pairing = (await createPairing({ displayBaseUrl: lanBaseUrl })).data;
  assert.equal(pairing.displayBaseUrl, lanBaseUrl);
  const completePairing = httpsCallable<{ pairingToken: string; venueCode: string; pin: string }, { displayUrl: string }>(functions, "completeDisplayPairing");
  const completed = (await completePairing({ pairingToken: pairing.pairingToken, venueCode: "my-cafe", pin: "123456" })).data;
  assert.ok(completed.displayUrl.startsWith(`${lanBaseUrl}/#`));
});
