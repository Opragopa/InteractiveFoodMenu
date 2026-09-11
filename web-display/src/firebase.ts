import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { browserLocalPersistence, connectAuthEmulator, getAuth, setPersistence } from "firebase/auth";
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
const isWebOs = /Web0S|webOS/i.test(navigator.userAgent);
const appCheckKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
// Older LG engines cannot run reCAPTCHA Enterprise reliably. Display links
// remain protected by an unguessable secret and Firebase Auth token.
if (appCheckKey && !isWebOs) {
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(appCheckKey),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(firebaseApp);
// Keep the staff session across page reloads and browser restarts. Explicitly
// setting this is important for Safari/iOS where the default can vary by mode.
void setPersistence(auth, browserLocalPersistence);
// IndexedDB persistence is optional for the display and is a frequent source
// of startup failures on older WebKit-based webOS TVs.
export const db = isWebOs
  ? getFirestore(firebaseApp)
  : initializeFirestore(firebaseApp, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }) });
export const functions = getFunctions(firebaseApp, import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || "europe-west1");
export const storage = getStorage(firebaseApp);

if (import.meta.env.VITE_USE_EMULATORS === "true") {
  const emulatorHost = import.meta.env.VITE_FIREBASE_EMULATOR_HOST || "127.0.0.1";
  connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, emulatorHost, 8080);
  connectFunctionsEmulator(functions, emulatorHost, 5001);
  connectStorageEmulator(storage, emulatorHost, 9199);
}
