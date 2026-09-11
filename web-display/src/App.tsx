import { useEffect, useState } from "react";
import { useEffect as useEffectQr } from "react";
import { onAuthStateChanged, signInWithCustomToken } from "firebase/auth";
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, updateDoc, where, writeBatch } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDownloadURL, ref } from "firebase/storage";
import { auth, db, functions, storage } from "./firebase";
import { DisplayScreen } from "./DisplayScreen";
import type { Category, MenuItem, Venue } from "./types";
import QRCode from "qrcode";
import { parseMenuCsv, type CsvMenuRow } from "./csv";
import { currentDisplayBaseUrl } from "./displayBaseUrl";
import { forgetVenueCredentials, saveVenueCredentials, savedVenueCredentials } from "./venueCredentials";

function installationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseDisplayHash() {
  const match = window.location.hash.match(/^#([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})$/);
  return match ? { tokenId: match[1], secret: match[2] } : null;
}

export function App() {
  if (window.location.pathname === "/connect") return <ConnectScreen />;
  if (window.location.pathname === "/staff") return <StaffScreen />;
  if (window.location.pathname === "/pair") return <PairScreen />;
  const [venueId, setVenueId] = useState<string | null>(null);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [logoUrl, setLogoUrl] = useState("");
  const [connected, setConnected] = useState(navigator.onLine);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const online = () => setConnected(true);
    const offline = () => setConnected(false);
    addEventListener("online", online);
    addEventListener("offline", offline);
    return () => {
      removeEventListener("online", online);
      removeEventListener("offline", offline);
    };
  }, []);

  useEffect(() => onAuthStateChanged(auth, async (user) => {
    if (user) {
      const token = await user.getIdTokenResult();
      const id = token.claims.venueId;
      if (typeof id === "string") setVenueId(id);
      setLoading(false);
      return;
    }
    const credentials = parseDisplayHash();
    if (!credentials) {
      setError("Откройте полную ссылку экрана из приложения сотрудника.");
      setLoading(false);
      return;
    }
    try {
      const login = httpsCallable<typeof credentials, { customToken: string; venueId: string }>(functions, "loginDisplay");
      const response = await login(credentials);
      await signInWithCustomToken(auth, response.data.customToken);
      setVenueId(response.data.venueId);
    } catch {
      setError("Ссылка экрана недействительна или была перевыпущена.");
      setLoading(false);
    }
  }), []);

  useEffect(() => {
    if (!venueId) return;
    const unsubVenue = onSnapshot(doc(db, "venues", venueId), { includeMetadataChanges: true }, (snapshot) => {
      if (snapshot.exists()) {
        const next = snapshot.data() as Venue;
        setVenue(next);
        setConnected(!snapshot.metadata.fromCache && navigator.onLine);
        if (next.logoPath) getDownloadURL(ref(storage, next.logoPath)).then(setLogoUrl).catch(() => setLogoUrl(""));
        else setLogoUrl("");
      }
      setLoading(false);
    }, () => setConnected(false));
    const unsubCategories = onSnapshot(query(collection(db, "categories"), where("venueId", "==", venueId)),
      (snapshot) => setCategories(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Category))),
      () => setConnected(false));
    const unsubItems = onSnapshot(query(collection(db, "items"), where("venueId", "==", venueId)),
      (snapshot) => setItems(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as MenuItem))),
      () => setConnected(false));
    return () => { unsubVenue(); unsubCategories(); unsubItems(); };
  }, [venueId]);

  if (loading) return <Status text="Подключаем меню…" />;
  if (error) return <Status text={error} error />;
  if (!venue) return <Status text="Меню пока недоступно. Проверьте подключение." error />;

  return <DisplayScreen venue={venue} categories={categories} items={items} logoUrl={logoUrl} connected={connected} />;
}

function StaffScreen() {
  const [savedCredentials] = useState(savedVenueCredentials);
  const [code, setCode] = useState(savedCredentials.code);
  const [pin, setPin] = useState(savedCredentials.pin);
  const [venueId, setVenueId] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"availability" | "categories" | "items">("availability");
  const [newCategory, setNewCategory] = useState("");
  const [newItem, setNewItem] = useState({ name: "", price: "", categoryId: "" });
  const [csvRows, setCsvRows] = useState<CsvMenuRow[]>([]);
  const login = async () => {
    setBusy(true); setError("");
    try {
      const call = httpsCallable<{ venueCode: string; pin: string; installationId: string }, { customToken: string; venueId: string }>(functions, "loginStaff");
      const response = await call({ venueCode: code.trim().toLowerCase(), pin, installationId: installationId() });
      await signInWithCustomToken(auth, response.data.customToken);
      saveVenueCredentials(code, pin);
      setVenueId(response.data.venueId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось войти"); }
    finally { setBusy(false); }
  };
  useEffect(() => onAuthStateChanged(auth, async (user) => {
    if (!user) { setVenueId(null); return; }
    const token = await user.getIdTokenResult();
    if (token.claims.role === "staff" && typeof token.claims.venueId === "string") setVenueId(token.claims.venueId);
  }), []);
  useEffect(() => {
    if (!venueId) return;
    const stopCategories = onSnapshot(query(collection(db, "categories"), where("venueId", "==", venueId)), s => setCategories(s.docs.map(d => ({ id: d.id, ...d.data() } as Category))));
    const stopItems = onSnapshot(query(collection(db, "items"), where("venueId", "==", venueId)), s => setItems(s.docs.map(d => ({ id: d.id, ...d.data() } as MenuItem))));
    return () => { stopCategories(); stopItems(); };
  }, [venueId]);
  if (!venueId) return <main className="staff-login"><h1>Меню в наличии</h1><h2>Кабинет сотрудника</h2><input placeholder="Код заведения" value={code} onChange={e => setCode(e.target.value)} /><input placeholder="PIN-код" type="password" value={pin} onChange={e => setPin(e.target.value)} /><button onClick={login} disabled={busy}>{busy ? "Входим…" : "Войти"}</button><small className="saved-credentials">Код сохраняется на устройстве, PIN — до закрытия браузера.</small><button className="link-button" onClick={() => { forgetVenueCredentials(); setCode(""); setPin(""); }}>Забыть данные точки</button>{error && <p className="status-error">{error}</p>}</main>;
  const grouped = categories.sort((a, b) => a.sortOrder - b.sortOrder).map(category => ({ category, items: items.filter(item => item.categoryId === category.id).sort((a, b) => a.sortOrder - b.sortOrder) }));
  const saveCategory = async () => { const name = newCategory.trim(); if (!name) return; await addDoc(collection(db, "categories"), { venueId, name, sortOrder: categories.length, updatedAt: serverTimestamp(), updatedBy: "web-staff" }); setNewCategory(""); };
  const saveItem = async () => { const priceMinor = Math.round(Number(newItem.price.replace(",", ".")) * 100); if (!newItem.name.trim() || !newItem.categoryId || !Number.isFinite(priceMinor)) return; await addDoc(collection(db, "items"), { venueId, categoryId: newItem.categoryId, name: newItem.name.trim(), priceMinor, sortOrder: items.filter(i => i.categoryId === newItem.categoryId).length, isAvailable: true, updatedAt: serverTimestamp(), updatedBy: "web-staff" }); setNewItem({ name: "", price: "", categoryId: newItem.categoryId }); };
  const importCsv = async () => {
    if (!csvRows.length) return;
    setBusy(true); setError("");
    try {
      const categoryIds = new Map(categories.map(category => [category.name.trim().toLocaleLowerCase(), category.id]));
      const categoryOrders = new Map(categories.map(category => [category.id, items.filter(item => item.categoryId === category.id).length]));
      const operations: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];
      csvRows.map(row => row.category).filter((name, index, names) => names.findIndex(other => other.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()) === index).forEach((name, index) => {
        const key = name.trim().toLocaleLowerCase();
        if (!categoryIds.has(key)) {
          const ref = doc(collection(db, "categories"));
          categoryIds.set(key, ref.id); categoryOrders.set(ref.id, 0);
          operations.push(batch => batch.set(ref, { venueId, name, sortOrder: categories.length + index, updatedAt: serverTimestamp(), updatedBy: "csv-import" }));
        }
      });
      csvRows.forEach(row => {
        const categoryId = categoryIds.get(row.category.trim().toLocaleLowerCase())!;
        const sortOrder = categoryOrders.get(categoryId) ?? 0;
        categoryOrders.set(categoryId, sortOrder + 1);
        const ref = doc(collection(db, "items"));
        operations.push(batch => batch.set(ref, { venueId, categoryId, name: row.name, priceMinor: row.priceMinor, sortOrder, isAvailable: row.isAvailable, updatedAt: serverTimestamp(), updatedBy: "csv-import" }));
      });
      for (let start = 0; start < operations.length; start += 500) { const batch = writeBatch(db); operations.slice(start, start + 500).forEach(operation => operation(batch)); await batch.commit(); }
      setCsvRows([]);
    } catch (cause) { setError(cause instanceof Error ? `Не удалось импортировать CSV: ${cause.message}` : "Не удалось импортировать CSV."); }
    finally { setBusy(false); }
  };
  const selectCsv = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try { setCsvRows(parseMenuCsv(await file.text())); }
    catch (cause) { setCsvRows([]); setError(cause instanceof Error ? cause.message : "Не удалось прочитать CSV."); }
  };
  return <main className="staff-menu"><header><h1>Меню в наличии</h1><button onClick={() => { auth.signOut(); setVenueId(null); }}>Выйти</button></header><nav className="staff-tabs"><button className={tab === "availability" ? "active" : ""} onClick={() => setTab("availability")}>Наличие</button><button className={tab === "categories" ? "active" : ""} onClick={() => setTab("categories")}>Категории</button><button className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>Позиции</button></nav>{tab === "availability" && grouped.map(group => <section key={group.category.id}><h2>{group.category.name}</h2>{group.items.map(item => <label className={!item.isAvailable ? "unavailable" : ""} key={item.id}><span><b>{item.name}</b><small>{(item.priceMinor / 100).toLocaleString("ru-RU", { style: "currency", currency: "RUB" })}</small></span><input type="checkbox" checked={!item.isAvailable} onChange={e => updateDoc(doc(db, "items", item.id), { isAvailable: !e.target.checked, updatedAt: serverTimestamp(), updatedBy: "web-staff" })} /><em>Нет в наличии</em></label>)}</section>)}{tab === "categories" && <section><h2>Категории</h2><div className="form-row"><input placeholder="Новая категория" value={newCategory} onChange={e => setNewCategory(e.target.value)} /><button onClick={saveCategory}>Добавить</button></div>{categories.sort((a, b) => a.sortOrder - b.sortOrder).map(category => <label key={category.id}><span><b>{category.name}</b></span><button onClick={() => deleteDoc(doc(db, "categories", category.id))}>Удалить</button></label>)}</section>}{tab === "items" && <section><h2>Позиции</h2><div className="form-row"><input placeholder="Название" value={newItem.name} onChange={e => setNewItem({ ...newItem, name: e.target.value })} /><input placeholder="Цена" inputMode="decimal" value={newItem.price} onChange={e => setNewItem({ ...newItem, price: e.target.value })} /><select value={newItem.categoryId || categories[0]?.id || ""} onChange={e => setNewItem({ ...newItem, categoryId: e.target.value })}>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button onClick={saveItem}>Добавить</button></div><div className="csv-import"><label>Загрузить CSV<input type="file" accept=".csv,text/csv" onChange={event => { void selectCsv(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><small>Столбцы: Категория, Название, Цена, В наличии (Да/Нет). Импорт добавляет позиции.</small>{csvRows.length > 0 && <button onClick={importCsv} disabled={busy}>{busy ? "Импорт…" : `Импортировать ${csvRows.length} поз.`}</button>}</div>{items.map(item => <label key={item.id}><span><b>{item.name}</b><small>{(item.priceMinor / 100).toLocaleString("ru-RU", { style: "currency", currency: "RUB" })}</small></span><button onClick={() => deleteDoc(doc(db, "items", item.id))}>Удалить</button></label>)}</section>}{error && <p className="status-error">{error}</p>}</main>;
}

function ConnectScreen() {
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  const secondsLeft = expiresAt === null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = expiresAt !== null && secondsLeft === 0;

  useEffect(() => {
    if (expiresAt === null || expired) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, expired]);

  useEffectQr(() => {
    let cancelled = false;
    let poll: number | undefined;
    (async () => {
      try {
        const create = httpsCallable<{ displayBaseUrl: string }, { pairingToken: string; displayBaseUrl: string; expiresInSeconds: number }>(functions, "createDisplayPairing");
        const response = await create({ displayBaseUrl: currentDisplayBaseUrl() });
        const pairingUrl = `${response.data.displayBaseUrl}/pair#${response.data.pairingToken}`;
        const dataUrl = await QRCode.toDataURL(pairingUrl, { margin: 2, width: 420 });
        if (!cancelled) {
          setQr(dataUrl);
          setNow(Date.now());
          setExpiresAt(Date.now() + response.data.expiresInSeconds * 1000);
        }
        const status = httpsCallable<{ pairingToken: string }, { status: string; displayUrl?: string | null }>(functions, "getDisplayPairingStatus");
        poll = window.setInterval(async () => {
          try {
            const result = await status({ pairingToken: response.data.pairingToken });
            if (result.data.status === "used" && result.data.displayUrl) {
              if (poll !== undefined) window.clearInterval(poll);
              window.location.href = result.data.displayUrl;
            }
          } catch { /* the QR remains visible until it expires */ }
        }, 2000);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Не удалось создать QR-код");
      }
    })();
    return () => { cancelled = true; if (poll !== undefined) window.clearInterval(poll); };
  }, [refreshKey]);
  return <main className="status connect-screen">
    <h1>Подключение телевизора</h1>
    {qr ? <><img src={qr} alt="QR-код подключения телевизора" /><p>Отсканируйте QR-код телефоном сотрудника и введите код точки и PIN.</p><p className={expired ? "pairing-expired" : "pairing-timer"}>{expired ? "Срок действия ключа истёк." : `До замены ключа: ${formatCountdown(secondsLeft)}`}</p>{expired && <button onClick={() => { setQr(""); setExpiresAt(null); setError(""); setRefreshKey(value => value + 1); }}>Обновить QR-код</button>}</> : <p>{error || "Создаём одноразовый QR-код…"}</p>}
  </main>;
}

function formatCountdown(seconds: number) {
  const twoDigits = (value: number) => value < 10 ? `0${value}` : String(value);
  const minutes = twoDigits(Math.floor(seconds / 60));
  const remainder = twoDigits(seconds % 60);
  return `${minutes}:${remainder}`;
}

function PairScreen() {
  const [savedCredentials] = useState(savedVenueCredentials);
  const [code, setCode] = useState(savedCredentials.code);
  const [pin, setPin] = useState(savedCredentials.pin);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = window.location.hash.slice(1);
  const complete = async () => {
    setBusy(true); setError("");
    try {
      const call = httpsCallable<{ pairingToken: string; venueCode: string; pin: string }, { displayUrl: string }>(functions, "completeDisplayPairing");
      const response = await call({ pairingToken: token, venueCode: code.trim().toLowerCase(), pin });
      saveVenueCredentials(code, pin);
      window.location.href = `${window.location.origin}/staff`;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Ссылка подключения недействительна"); }
    finally { setBusy(false); }
  };
  return <main className="staff-login"><h1>Подключить телевизор</h1><h2>Введите данные точки</h2><input placeholder="Код заведения" value={code} onChange={e => setCode(e.target.value)} /><input placeholder="PIN-код" type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} /><button onClick={complete} disabled={busy || !token}>{busy ? "Подключаем…" : "Подключить телевизор"}</button><small className="saved-credentials">Код сохраняется на устройстве, PIN — до закрытия браузера.</small><button className="link-button" onClick={() => { forgetVenueCredentials(); setCode(""); setPin(""); }}>Забыть данные точки</button>{error && <p className="status-error">{error}</p>}</main>;
}

function Status({ text, error = false }: { text: string; error?: boolean }) {
  return <main className={`status ${error ? "status-error" : ""}`}><p>{text}</p></main>;
}
