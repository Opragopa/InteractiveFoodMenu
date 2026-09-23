import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEffect as useEffectQr } from "react";
import { DisplayScreen } from "./DisplayScreen";
import type { Category, MenuItem, Venue } from "./types";
import QRCode from "qrcode";
import { parseMenuCsv, type CsvMenuRow } from "./csv";
import { forgetVenueCredentials, saveVenueCredentials, savedVenueCredentials } from "./venueCredentials";
import { reportClientError } from "./clientLogger";
import { BackendHub } from "./BackendHub";
import { api } from "./api";

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
  if (window.location.pathname === "/hub") return <BackendHub />;
  if (window.location.pathname === "/connect") return <ConnectScreen />;
  if (window.location.pathname === "/staff") return <StaffScreen />;
  if (window.location.pathname === "/pair") return <PairScreen />;
  const [sessionToken, setSessionToken] = useState("");
  const [venue, setVenue] = useState<Venue | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [connected, setConnected] = useState(navigator.onLine);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [menuRefreshSeconds, setMenuRefreshSeconds] = useState(15);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const hasLoadedMenuRef = useRef(false);
  const menuVersionRef = useRef<number | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    const login = async () => {
    const credentials = parseDisplayHash();
    if (!credentials) {
      setError("Откройте полную ссылку экрана из приложения сотрудника.");
      setLoading(false);
      return;
    }
    try {
      const response = await api.displayLogin(credentials.tokenId, credentials.secret);
      if (!cancelled) setSessionToken(response.token);
    } catch (cause) {
      reportClientError("display_login_failed", cause, { path: window.location.pathname });
      setError("Ссылка экрана недействительна или была перевыпущена.");
      setLoading(false);
    }
    };
    void login();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    const load = async () => {
      try {
        const menu = await api.menu(sessionToken);
        if (!cancelled) {
          hasLoadedMenuRef.current = true;
          menuVersionRef.current = Number((menu.venue as Venue).menuVersion ?? 1);
          setMenuRefreshSeconds(Math.min(300, Math.max(5, Number((menu.venue as Venue).menuRefreshSeconds ?? 15))));
          setVenue(menu.venue as Venue); setCategories(menu.categories as Category[]); setItems(menu.items as MenuItem[]);
          setLastUpdatedAt(Date.now()); setConnected(true); setError(""); setLoading(false);
        }
      } catch (cause) {
        if (!cancelled) {
          setConnected(false); setLoading(false);
          if (!hasLoadedMenuRef.current) setError(cause instanceof Error ? cause.message : "Меню недоступно.");
        }
      }
    };
    void load();
    const timer = window.setInterval(async () => {
      try {
        const version = await api.menuVersion(sessionToken);
        if (version.version !== menuVersionRef.current) await load();
        else setConnected(true);
      } catch {
        if (!cancelled) setConnected(false);
      }
    }, menuRefreshSeconds * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionToken, menuRefreshSeconds]);

  if (loading) return <Status text="Подключаем меню…" />;
  if (error) return <Status text={error} error />;
  if (!venue) return <Status text="Меню пока недоступно. Проверьте подключение." error />;

  return <DisplayScreen venue={venue} categories={categories} items={items} logoUrl={venue.logoFileId ? api.venueAssetUrl(venue.logoFileId) : "/politech-logo-white.svg"} connected={connected} updatedAt={lastUpdatedAt} />;
}

function StaffScreen() {
  const [savedCredentials] = useState(savedVenueCredentials);
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get("venue")?.trim().toLowerCase() || savedCredentials.code);
  const [pin, setPin] = useState(savedCredentials.pin);
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem("ifm-staff-session") ?? "");
  const [venue, setVenue] = useState<Venue | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"availability" | "categories" | "items" | "settings">("availability");
  const [newCategory, setNewCategory] = useState("");
  const [newItem, setNewItem] = useState({ name: "", price: "", categoryId: "" });
  const [csvRows, setCsvRows] = useState<CsvMenuRow[]>([]);
  const availabilityListRef = useRef<HTMLDivElement | null>(null);
  const previousRowsRef = useRef<Map<string, number> | null>(null);
  const login = async () => {
    setBusy(true); setError("");
    try {
      const response = await api.staffLogin(code.trim().toLowerCase(), pin);
      saveVenueCredentials(code, pin);
      localStorage.setItem("ifm-staff-session", response.token);
      setSessionToken(response.token);
    } catch (cause) {
      reportClientError("staff_login_failed", cause);
      setError(cause instanceof Error ? cause.message : "Не удалось войти");
    }
    finally { setBusy(false); }
  };
  const loadMenu = useCallback(async () => {
    if (!sessionToken) return;
    const menu = await api.menu(sessionToken);
    setVenue(menu.venue as Venue);
    setCategories(menu.categories as Category[]);
    setItems(menu.items as MenuItem[]);
  }, [sessionToken]);
  useEffect(() => {
    if (!sessionToken) return;
    void loadMenu().catch(cause => setError(cause instanceof Error ? cause.message : "Не удалось загрузить меню."));
  }, [sessionToken, loadMenu]);
  useLayoutEffect(() => {
    const previous = previousRowsRef.current;
    const root = availabilityListRef.current;
    if (!previous) return;
    if (!root) { previousRowsRef.current = null; return; }
    previousRowsRef.current = null;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-item-id]"));
    rows.forEach(row => {
      const oldTop = previous.get(row.dataset.itemId ?? "");
      if (oldTop === undefined) return;
      const delta = oldTop - row.getBoundingClientRect().top;
      if (!delta) return;
      row.style.transition = "none";
      row.style.transform = `translateY(${delta}px)`;
    });
    requestAnimationFrame(() => requestAnimationFrame(() => rows.forEach(row => {
      row.style.transition = "transform 360ms cubic-bezier(.2,.8,.2,1)";
      row.style.transform = "translateY(0)";
    })));
  }, [items]);
  if (!sessionToken) return <main className="staff-login"><h1>Меню в наличии</h1><h2>Кабинет сотрудника</h2><input placeholder="Код заведения" value={code} onChange={e => setCode(e.target.value)} /><input placeholder="PIN-код" type="password" value={pin} onChange={e => setPin(e.target.value)} /><button onClick={login} disabled={busy}>{busy ? "Входим…" : "Войти"}</button><small className="saved-credentials">Код сохраняется на устройстве, PIN — до закрытия браузера.</small><button className="link-button" onClick={() => { forgetVenueCredentials(); setCode(""); setPin(""); }}>Забыть данные точки</button>{error && <p className="status-error">{error}</p>}</main>;
  const grouped = categories.sort((a, b) => a.sortOrder - b.sortOrder).map(category => ({ category, items: items.filter(item => item.categoryId === category.id).sort((a, b) => Number(a.isAvailable === false) - Number(b.isAvailable === false) || a.sortOrder - b.sortOrder) }));
  const toggleAvailability = async (item: MenuItem, unavailable: boolean) => {
    const root = availabilityListRef.current;
    previousRowsRef.current = new Map(Array.from(root?.querySelectorAll<HTMLElement>("[data-item-id]") ?? []).map(row => [row.dataset.itemId ?? "", row.getBoundingClientRect().top]));
    setItems(current => current.map(value => value.id === item.id ? { ...value, isAvailable: !unavailable } : value));
    try {
      await api.updateItem(sessionToken, item.id, { isAvailable: !unavailable });
    } catch (cause) {
      const currentRoot = availabilityListRef.current;
      previousRowsRef.current = new Map(Array.from(currentRoot?.querySelectorAll<HTMLElement>("[data-item-id]") ?? []).map(row => [row.dataset.itemId ?? "", row.getBoundingClientRect().top]));
      setItems(current => current.map(value => value.id === item.id ? { ...value, isAvailable: item.isAvailable } : value));
      reportClientError("availability_update_failed", cause, { itemId: item.id });
      setError(cause instanceof Error ? `Не удалось обновить наличие: ${cause.message}` : "Не удалось обновить наличие.");
    }
  };
  const saveCategory = async () => { const name = newCategory.trim(); if (!name) return; const result = await api.createCategory(sessionToken, { name, sortOrder: categories.length }); setCategories(current => [...current, result.category as Category]); setNewCategory(""); };
  const saveItem = async () => { const priceMinor = Math.round(Number(newItem.price.replace(",", ".")) * 100); if (!newItem.name.trim() || !newItem.categoryId || !Number.isFinite(priceMinor)) return; const result = await api.createItem(sessionToken, { categoryId: newItem.categoryId, name: newItem.name.trim(), priceMinor, sortOrder: items.filter(i => i.categoryId === newItem.categoryId).length, isAvailable: true }); setItems(current => [...current, result.item as MenuItem]); setNewItem({ name: "", price: "", categoryId: newItem.categoryId }); };
  const saveVenueSettings = async (settings: Pick<Venue, "name" | "backgroundColor" | "accentColor" | "pageDurationSeconds" | "displayScalePercent">) => {
    setBusy(true);
    try {
      const result = await api.updateVenue(sessionToken, settings);
      setVenue(result.venue as Venue);
    } finally { setBusy(false); }
  };
  const importCsv = async () => {
    if (!csvRows.length) return;
    setBusy(true); setError("");
    try {
      const categoryIds = new Map(categories.map(category => [category.name.trim().toLocaleLowerCase(), category.id]));
      const categoryOrders = new Map(categories.map(category => [category.id, items.filter(item => item.categoryId === category.id).length]));
      for (const [index, name] of csvRows.map(row => row.category).filter((name, index, names) => names.findIndex(other => other.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()) === index).entries()) {
        const key = name.trim().toLocaleLowerCase();
        if (!categoryIds.has(key)) {
          const result = await api.createCategory(sessionToken, { name, sortOrder: categories.length + index });
          categoryIds.set(key, result.category.id); categoryOrders.set(result.category.id, 0);
        }
      }
      for (const row of csvRows) {
        const categoryId = categoryIds.get(row.category.trim().toLocaleLowerCase())!;
        const sortOrder = categoryOrders.get(categoryId) ?? 0;
        categoryOrders.set(categoryId, sortOrder + 1);
        await api.createItem(sessionToken, { categoryId, name: row.name, priceMinor: row.priceMinor, sortOrder, isAvailable: row.isAvailable });
      }
      setCsvRows([]);
      await loadMenu();
    } catch (cause) { setError(cause instanceof Error ? `Не удалось импортировать CSV: ${cause.message}` : "Не удалось импортировать CSV."); }
    finally { setBusy(false); }
  };
  const selectCsv = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try { setCsvRows(parseMenuCsv(await file.text())); }
    catch (cause) { setCsvRows([]); setError(cause instanceof Error ? cause.message : "Не удалось прочитать CSV."); }
  };
  return (
    <main className="staff-menu">
      <header>
        <h1>Меню в наличии</h1>
        <button onClick={() => void loadMenu().then(() => setError("")).catch(cause => setError(cause instanceof Error ? cause.message : "Не удалось обновить меню."))}>Обновить</button>
        <button onClick={() => { localStorage.removeItem("ifm-staff-session"); setSessionToken(""); }}>Выйти</button>
      </header>
      <nav className="staff-tabs">
        <button className={tab === "availability" ? "active" : ""} onClick={() => setTab("availability")}>Наличие</button>
        <button className={tab === "categories" ? "active" : ""} onClick={() => setTab("categories")}>Категории</button>
        <button className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>Позиции</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Настройки</button>
      </nav>
      {tab === "availability" && <div ref={availabilityListRef} className="availability-list">{grouped.map(group => (
        <section key={group.category.id}>
          <h2>{group.category.name}</h2>
          {group.items.map(item => (
            <label className={!item.isAvailable ? "unavailable" : ""} data-item-id={item.id} key={item.id}>
              <span><b>{item.name}</b><small>{(item.priceMinor / 100).toLocaleString("ru-RU", { style: "currency", currency: "RUB" })}</small></span>
              <input type="checkbox" checked={!item.isAvailable} onChange={event => void toggleAvailability(item, event.target.checked)} />
              <em>Нет в наличии</em>
            </label>
          ))}
        </section>
      ))}</div>}
      {tab === "categories" && (
        <section>
          <h2>Категории</h2>
          <div className="form-row"><input placeholder="Новая категория" value={newCategory} onChange={event => setNewCategory(event.target.value)} /><button onClick={saveCategory}>Добавить</button></div>
          {categories.sort((a, b) => a.sortOrder - b.sortOrder).map(category => <label key={category.id}><span><b>{category.name}</b></span><button onClick={() => void api.deleteCategory(sessionToken, category.id).then(() => setCategories(current => current.filter(value => value.id !== category.id))).catch(cause => setError(cause instanceof Error ? cause.message : "Не удалось удалить категорию."))}>Удалить</button></label>)}
        </section>
      )}
      {tab === "items" && (
        <section>
          <h2>Позиции</h2>
          <div className="form-row">
            <input placeholder="Название" value={newItem.name} onChange={event => setNewItem({ ...newItem, name: event.target.value })} />
            <input placeholder="Цена" inputMode="decimal" value={newItem.price} onChange={event => setNewItem({ ...newItem, price: event.target.value })} />
            <select value={newItem.categoryId || categories[0]?.id || ""} onChange={event => setNewItem({ ...newItem, categoryId: event.target.value })}>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
            <button onClick={saveItem}>Добавить</button>
          </div>
          <div className="csv-import">
            <label>Загрузить CSV<input type="file" accept=".csv,text/csv" onChange={event => { void selectCsv(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
            <small>Столбцы: Категория, Название, Цена, В наличии (Да/Нет). Импорт добавляет позиции.</small>
            {csvRows.length > 0 && <button onClick={importCsv} disabled={busy}>{busy ? "Импорт…" : `Импортировать ${csvRows.length} поз.`}</button>}
          </div>
          {items.map(item => <label key={item.id}><span><b>{item.name}</b><small>{(item.priceMinor / 100).toLocaleString("ru-RU", { style: "currency", currency: "RUB" })}</small></span><button onClick={() => void api.deleteItem(sessionToken, item.id).then(() => setItems(current => current.filter(value => value.id !== item.id))).catch(cause => setError(cause instanceof Error ? cause.message : "Не удалось удалить позицию."))}>Удалить</button></label>)}
        </section>
      )}
      {tab === "settings" && venue && <VenueSettings venue={venue} busy={busy} onSave={saveVenueSettings} />}
      {error && <p className="status-error">{error}</p>}
    </main>
  );
}

function VenueSettings({ venue, busy, onSave }: {
  venue: Venue;
  busy: boolean;
  onSave: (settings: Pick<Venue, "name" | "backgroundColor" | "accentColor" | "pageDurationSeconds" | "displayScalePercent">) => Promise<void>;
}) {
  const [name, setName] = useState(venue.name);
  const [backgroundColor, setBackgroundColor] = useState(venue.backgroundColor);
  const [accentColor, setAccentColor] = useState(venue.accentColor);
  const [duration, setDuration] = useState(venue.pageDurationSeconds);
  const [displayScale, setDisplayScale] = useState(Math.min(160, Math.max(80, venue.displayScalePercent ?? 100)));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setName(venue.name);
    setBackgroundColor(venue.backgroundColor);
    setAccentColor(venue.accentColor);
    setDuration(venue.pageDurationSeconds);
    setDisplayScale(Math.min(160, Math.max(80, venue.displayScalePercent ?? 100)));
  }, [venue]);

  const save = async () => {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80) { setError("Название должно содержать от 1 до 80 символов."); return; }
    if (!/^#[0-9a-f]{6}$/i.test(backgroundColor) || !/^#[0-9a-f]{6}$/i.test(accentColor)) { setError("Укажите цвета в формате #RRGGBB."); return; }
    setError(""); setMessage("");
    try {
      await onSave({ name: normalizedName, backgroundColor: backgroundColor.toUpperCase(), accentColor: accentColor.toUpperCase(), pageDurationSeconds: duration, displayScalePercent: displayScale });
      setMessage("Настройки сохранены. Экран обновится автоматически.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки."); }
  };

  return <section className="venue-settings"><h2>Оформление меню</h2>
    <label className="setting-field"><span>Название точки</span><input maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
    <ColorSetting label="Цвет фона" value={backgroundColor} onChange={setBackgroundColor} />
    <ColorSetting label="Акцентный цвет" value={accentColor} onChange={setAccentColor} />
    <div className="setting-field duration-setting"><span>Смена страниц</span><div className="duration-control"><button type="button" aria-label="Уменьшить интервал" disabled={duration <= 5} onClick={() => setDuration(value => Math.max(5, value - 1))}>−</button><strong>{duration} сек.</strong><button type="button" aria-label="Увеличить интервал" disabled={duration >= 60} onClick={() => setDuration(value => Math.min(60, value + 1))}>+</button></div><small>Если меню не помещается на одной странице, ТВ будет переключать страницы с этим интервалом.</small></div>
    <div className="setting-field duration-setting"><span>Масштаб меню ТВ</span><div className="duration-control"><button type="button" aria-label="Уменьшить масштаб" disabled={displayScale <= 80} onClick={() => setDisplayScale(value => Math.max(80, value - 5))}>−</button><strong>{displayScale}%</strong><button type="button" aria-label="Увеличить масштаб" disabled={displayScale >= 160} onClick={() => setDisplayScale(value => Math.min(160, value + 5))}>+</button></div><small>Увеличивает текст и отступы; при крупном масштабе на странице будет меньше позиций.</small></div>
    <button className="save-settings" type="button" disabled={busy} onClick={() => void save()}>{busy ? "Сохраняем…" : "Сохранить оформление"}</button>
    {message && <p className="settings-success">{message}</p>}{error && <p className="status-error">{error}</p>}
  </section>;
}

function ColorSetting({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const color = /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
  return <label className="setting-field color-setting"><span>{label}</span><input aria-label={`${label}: выбрать`} type="color" value={color} onChange={event => onChange(event.target.value.toUpperCase())} /><input aria-label={`${label}: HEX`} maxLength={7} value={value} onChange={event => onChange(event.target.value)} /></label>;
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
        const response = await api.createPairing();
        const pairingUrl = `${response.displayBaseUrl}/pair#${response.pairingToken}`;
        const dataUrl = await QRCode.toDataURL(pairingUrl, { margin: 2, width: 420 });
        if (!cancelled) {
          setQr(dataUrl);
          setNow(Date.now());
          setExpiresAt(Date.now() + response.expiresInSeconds * 1000);
        }
        poll = window.setInterval(async () => {
          try {
            const result = await api.pairingStatus(response.pairingToken);
            if (result.status === "complete" && result.displayUrl) {
              if (poll !== undefined) window.clearInterval(poll);
              window.location.href = result.displayUrl;
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
      await api.completePairing(token, code.trim().toLowerCase(), pin);
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
