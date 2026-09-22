import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { browserLocalPersistence, connectAuthEmulator, getAuth, inMemoryPersistence, setPersistence } from "firebase/auth";
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
} from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";
import { connectStorageEmulator, getStorage } from "firebase/storage";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseApp = initializeApp(config);
const userAgent = navigator.userAgent || "";
const isWebOs = /Web0S|webOS/i.test(userAgent);
const tizen = /Tizen\s+(\d+(?:\.\d+)?)/i.exec(userAgent);
const isLegacySamsung = /SMART-TV|TV Safari/i.test(userAgent) && tizen !== null && parseFloat(tizen[1]) < 6;
const isLegacyTv = isWebOs || isLegacySamsung;
const appCheckKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
// Display callables do not enforce App Check. Skip its unsupported browser
// integration on legacy TVs; pairing/display access uses a one-time secret
// and Firebase Auth instead.
if (appCheckKey && !isLegacyTv) {
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(appCheckKey),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(firebaseApp);
// Keep the staff session across page reloads and browser restarts. Explicitly
// setting this is important for Safari/iOS where the default can vary by mode.
// Persistence can be unavailable in private/restricted browser contexts. Auth
// still works in memory, so this must not abort the whole application.
void setPersistence(auth, isLegacyTv ? inMemoryPersistence : browserLocalPersistence).catch(() => undefined);
// Old TV browsers can expose incomplete IndexedDB implementations. The TV can
// re-authenticate from its display link, so durable local cache is unnecessary.
export const db = isLegacyTv
  ? getFirestore(firebaseApp)
  : initializeFirestore(firebaseApp, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }) });
export const functions = getFunctions(firebaseApp, import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || "europe-west1");
export const storage = getStorage(firebaseApp);

if (import.meta.env.VITE_USE_EMULATORS === "true") {
  const emulatorHost = import.meta.env.VITE_FIREBASE_EMULATOR_HOST || "127.0.0.1";
  connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, emulatorHost, 8080);
  if (import.meta.env.VITE_FUNCTIONS_PROXY === "true") {
    // Keep TV calls on the same LAN origin/port as Vite. The dev server
    // forwards callable requests to the local Functions Emulator.
    connectFunctionsEmulator(functions, window.location.hostname, Number(window.location.port) || 5173);
  } else {
    connectFunctionsEmulator(functions, emulatorHost, 5001);
  }
  connectStorageEmulator(storage, emulatorHost, 9199);
}
