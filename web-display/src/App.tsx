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
import { displayPresets, normalizeVenueAppearance, type DisplayPreset, type VenueAppearance } from "./venueSettings";
import { estimateMenuPages } from "./paginate";

const previewSizes = {
  "1366x768": { width: 1366, height: 768, label: "1366 × 768" },
  "1920x1080": { width: 1920, height: 1080, label: "1920 × 1080" },
  "3840x2160": { width: 3840, height: 2160, label: "3840 × 2160" },
} as const;
type PreviewSize = keyof typeof previewSizes;
const previewMoney = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 });

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
  const legacyBrowser = typeof window.fetch !== "function";

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
        // Chrome 38/NetCast can cache or mishandle lightweight version
        // requests. Its XHR fallback is reliable, so refresh the full menu
        // only on legacy TVs; modern browsers keep the cheap version poll.
        if (legacyBrowser) {
          await load();
          return;
        }
        const version = await api.menuVersion(sessionToken);
        if (version.version !== menuVersionRef.current) await load();
        else setConnected(true);
      } catch {
        if (!cancelled) setConnected(false);
      }
    }, Math.min(menuRefreshSeconds, 2) * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionToken, menuRefreshSeconds, legacyBrowser]);

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
  const [tab, setTab] = useState<"availability" | "categories" | "items" | "settings" | "experimental">("availability");
  const [newCategory, setNewCategory] = useState("");
  const [newItem, setNewItem] = useState({ name: "", price: "", categoryId: "" });
  const [csvRows, setCsvRows] = useState<CsvMenuRow[]>([]);
  const [breakDuration, setBreakDuration] = useState(10);
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
    setBreakDuration(Number(menu.venue.breakDurationMinutes ?? 10));
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
  if (!sessionToken) return <main className="auth-shell"><section className="auth-card staff-login"><span className="auth-kicker">InteractiveFoodMenu</span><h1>Кабинет сотрудника</h1><p className="auth-lead">Управляйте наличием блюд и настройками точки.</p><label>Код точки<input autoComplete="username" placeholder="например, nevsky" value={code} onChange={e => setCode(e.target.value)} /></label><label>Шестизначный PIN<input autoComplete="current-password" placeholder="••••••" type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} /></label><button onClick={login} disabled={busy || !code || pin.length !== 6}>{busy ? "Проверяем…" : "Войти в кабинет"}</button><small className="saved-credentials">Код сохраняется на устройстве, PIN используется только для входа.</small><button className="link-button" onClick={() => { forgetVenueCredentials(); setCode(""); setPin(""); }}>Забыть сохранённые данные</button>{error && <p role="alert" className="status-error">{error}</p>}</section></main>;
  const grouped = categories.sort((a, b) => a.sortOrder - b.sortOrder).map(category => ({ category, items: items.filter(item => item.categoryId === category.id).sort((a, b) => Number(a.isAvailable === false) - Number(b.isAvailable === false) || a.sortOrder - b.sortOrder) }));
  const toggleAvailability = async (item: MenuItem, unavailable: boolean) => {
    const root = availabilityListRef.current;
    previousRowsRef.current = new Map(Array.from(root?.querySelectorAll<HTMLElement>("[data-item-id]") ?? []).map(row => [row.dataset.itemId ?? "", row.getBoundingClientRect().top]));
    setItems(current => current.map(value => value.id === item.id ? { ...value, isAvailable: !unavailable } : value));
    try {
      const result = await api.updateItem(sessionToken, item.id, { isAvailable: !unavailable });
      // Use the persisted value returned by Appwrite. This prevents a later
      // render/sort from restoring the stale checkbox state from the closure.
      setItems(current => current.map(value => value.id === item.id ? result.item as MenuItem : value));
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
  const deleteCategory = async (category: Category) => {
    if (!window.confirm(`Удалить категорию «${category.name}»? Все её позиции должны быть удалены заранее. Действие необратимо.`)) return;
    try { await api.deleteCategory(sessionToken, category.id); setCategories(current => current.filter(value => value.id !== category.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить категорию."); }
  };
  const deleteItem = async (item: MenuItem) => {
    if (!window.confirm(`Удалить позицию «${item.name}»? Восстановить её автоматически будет нельзя.`)) return;
    try { await api.deleteItem(sessionToken, item.id); setItems(current => current.filter(value => value.id !== item.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить позицию."); }
  };
  const saveVenueSettings = async (settings: Partial<Venue>) => {
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
  const startBreak = async () => { setBusy(true); try { const result = await api.startBreak(sessionToken, Math.min(60, Math.max(1, breakDuration))); setVenue(result.venue as Venue); } finally { setBusy(false); } };
  const stopBreak = async () => { setBusy(true); try { const result = await api.stopBreak(sessionToken); setVenue(result.venue as Venue); } finally { setBusy(false); } };
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
        {venue?.breakActive ? <button onClick={() => void stopBreak()} disabled={busy}>Завершить перерыв</button> : <span className="break-control"><input aria-label="Длительность перерыва" type="number" min={1} max={60} value={breakDuration} onChange={e => setBreakDuration(Number(e.target.value))} /><button onClick={() => void startBreak()} disabled={busy}>Перерыв</button></span>}
      </header>
      <nav className="staff-tabs">
        <button className={tab === "availability" ? "active" : ""} onClick={() => setTab("availability")}>Наличие</button>
        <button className={tab === "categories" ? "active" : ""} onClick={() => setTab("categories")}>Категории</button>
        <button className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>Позиции</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Настройки</button>
        <button className={tab === "experimental" ? "active" : ""} onClick={() => setTab("experimental")}>Экспериментальные функции</button>
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
          {categories.sort((a, b) => a.sortOrder - b.sortOrder).map(category => <label key={category.id}><span><b>{category.name}</b></span><button className="danger-action" onClick={() => void deleteCategory(category)}>Удалить</button></label>)}
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
          {items.map(item => <label key={item.id}><span><b>{item.name}</b><small>{(item.priceMinor / 100).toLocaleString("ru-RU", { style: "currency", currency: "RUB" })}</small></span><button className="danger-action" onClick={() => void deleteItem(item)}>Удалить</button></label>)}
        </section>
      )}
      {tab === "settings" && venue && <VenueSettings venue={venue} busy={busy} onSave={saveVenueSettings} />}
      {tab === "experimental" && venue && <ExperimentalSettings venue={venue} categories={categories} items={items} busy={busy} onSave={saveVenueSettings} />}
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
    <div className="setting-field duration-setting"><span>Смена страниц</span><div className="duration-control"><button type="button" aria-label="Уменьшить интервал" disabled={duration <= 5} onClick={() => setDuration(value => Math.max(5, value - 1))}>−</button><strong>{duration} сек.</strong><button type="button" aria-label="Увеличить интервал" disabled={duration >= 30} onClick={() => setDuration(value => Math.min(30, value + 1))}>+</button></div><small>Если меню не помещается на одной странице, ТВ будет переключать страницы с этим интервалом.</small></div>
    <div className="setting-field duration-setting"><span>Масштаб меню ТВ</span><div className="duration-control"><button type="button" aria-label="Уменьшить масштаб" disabled={displayScale <= 80} onClick={() => setDisplayScale(value => Math.max(80, value - 5))}>−</button><strong>{displayScale}%</strong><button type="button" aria-label="Увеличить масштаб" disabled={displayScale >= 160} onClick={() => setDisplayScale(value => Math.min(160, value + 5))}>+</button></div><small>Увеличивает текст и отступы; при крупном масштабе на странице будет меньше позиций.</small></div>
    <button className="save-settings" type="button" disabled={busy} onClick={() => void save()}>{busy ? "Сохраняем…" : "Сохранить оформление"}</button>
    {message && <p className="settings-success">{message}</p>}{error && <p className="status-error">{error}</p>}
  </section>;
}

function ExperimentalSettings({ venue, categories, items, busy, onSave }: {
  venue: Venue;
  categories: Category[];
  items: MenuItem[];
  busy: boolean;
  onSave: (settings: Partial<Venue>) => Promise<void>;
}) {
  const [preset, setPreset] = useState<DisplayPreset>(venue.displayPreset ?? "balanced");
  const [panelWidth, setPanelWidth] = useState(venue.breakPanelWidthPercent ?? 36);
  const [dimPercent, setDimPercent] = useState(venue.breakMenuDimPercent ?? 45);
  const [fontSize, setFontSize] = useState(venue.menuItemFontSizePx ?? 34);
  const [itemGap, setItemGap] = useState(venue.menuItemGapPx ?? 12);
  const [pageDuration, setPageDuration] = useState(Math.min(30, venue.pageDurationSeconds || 10));
  const [transitionMs, setTransitionMs] = useState(venue.breakTransitionMs ?? 600);
  const [expiredText, setExpiredText] = useState(venue.breakExpiredText ?? "Скоро буду");
  const [testBreak, setTestBreak] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const [previewSize, setPreviewSize] = useState<PreviewSize>("1366x768");
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectedPreview = previewSizes[previewSize];
  const previewWidth = selectedPreview.width * (testBreak ? (100 - panelWidth) / 100 : 1);
  const expectedPages = Math.max(1, estimateMenuPages(categories, items, previewWidth, selectedPreview.height, fontSize, itemGap));
  const previewItems = items.slice(0, 8);

  useEffect(() => { setPreviewPage((value) => Math.min(value, expectedPages - 1)); }, [expectedPages]);
  useEffect(() => {
    if (paused || expectedPages <= 1) return;
    const timer = window.setInterval(() => setPreviewPage((value) => (value + 1) % expectedPages), pageDuration * 1000);
    return () => window.clearInterval(timer);
  }, [paused, expectedPages, pageDuration]);

  const applyPreset = (next: DisplayPreset) => {
    const values = displayPresets[next];
    setPreset(next); setPanelWidth(values.breakPanelWidthPercent!); setDimPercent(values.breakMenuDimPercent!);
    setFontSize(values.menuItemFontSizePx!); setItemGap(values.menuItemGapPx!); setPageDuration(values.pageDurationSeconds); setTransitionMs(values.breakTransitionMs!);
  };
  const reset = () => { applyPreset("balanced"); setExpiredText("Скоро буду"); };
  const save = async () => {
    setError(""); setMessage("");
    try {
      const normalized = normalizeVenueAppearance({
        name: venue.name, backgroundColor: venue.backgroundColor, accentColor: venue.accentColor,
        pageDurationSeconds: pageDuration, displayScalePercent: venue.displayScalePercent ?? 100,
        displayScaleMode: venue.displayScaleMode, logoPosition: venue.logoPosition ?? "top-right", logoInsetPercent: venue.logoInsetPercent ?? 3,
        logoScalePercent: venue.logoScalePercent ?? 100, logoVisible: venue.logoVisible, menuRefreshSeconds: venue.menuRefreshSeconds,
        breakFontSizePercent: venue.breakFontSizePercent, breakPanelWidthPercent: panelWidth, breakMenuDimPercent: dimPercent,
        menuItemFontSizePx: fontSize, menuItemGapPx: itemGap, breakTransitionMs: transitionMs, displayPreset: preset, breakExpiredText: expiredText,
      });
      await onSave({
        pageDurationSeconds: normalized.pageDurationSeconds, breakPanelWidthPercent: normalized.breakPanelWidthPercent,
        breakMenuDimPercent: normalized.breakMenuDimPercent, menuItemFontSizePx: normalized.menuItemFontSizePx,
        menuItemGapPx: normalized.menuItemGapPx, breakTransitionMs: normalized.breakTransitionMs,
        displayPreset: normalized.displayPreset, breakExpiredText: normalized.breakExpiredText,
      });
      setMessage("Экспериментальные настройки сохранены и будут применены на экране автоматически.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки."); }
  };

  return <section className="experimental-settings"><div className="experimental-heading"><div><h2>Экспериментальные функции</h2><p>Настройте пагинацию и двухколоночный режим перерыва.</p></div><span className="page-estimate">Ожидается страниц: <b>{expectedPages}</b></span></div>
    <div className="preset-buttons">{(["compact", "balanced", "large"] as DisplayPreset[]).map(value => <button type="button" className={preset === value ? "active" : ""} key={value} onClick={() => applyPreset(value)}>{({ compact: "Компактный", balanced: "Сбалансированный", large: "Крупный" })[value]}</button>)}</div>
    {expectedPages > 5 && <p className="settings-warning">При выбранном размере текста и отступах меню будет состоять более чем из пяти страниц.</p>}
    <div className="experimental-grid">
      <RangeSetting label="Ширина панели перерыва" value={panelWidth} unit="%" min={30} max={50} step={1} onChange={setPanelWidth} />
      <RangeSetting label="Приглушение меню" value={dimPercent} unit="%" min={25} max={75} step={5} onChange={setDimPercent} />
      <RangeSetting label="Размер названий" value={fontSize} unit="px" min={22} max={54} step={1} onChange={setFontSize} />
      <RangeSetting label="Вертикальные отступы" value={itemGap} unit="px" min={4} max={28} step={1} onChange={setItemGap} />
      <RangeSetting label="Смена страниц" value={pageDuration} unit="сек." min={5} max={30} step={1} onChange={setPageDuration} />
      <RangeSetting label="Переход часов и таймера" value={transitionMs} unit="мс" min={200} max={1200} step={100} onChange={setTransitionMs} />
      <label className="experimental-text">Текст после окончания таймера<input maxLength={80} value={expiredText} onChange={event => setExpiredText(event.target.value)} /></label>
    </div>
    <label className="preview-resolution">Разрешение предпросмотра<select value={previewSize} onChange={event => setPreviewSize(event.target.value as PreviewSize)}>{Object.entries(previewSizes).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}</select></label>
    <div className={`experimental-preview ${testBreak ? "is-break" : ""}`} style={{ "--preview-panel": `${panelWidth}%`, "--preview-dim": (100 - dimPercent) / 100, "--preview-transition": `${transitionMs}ms`, "--preview-font-size": `${fontSize}px`, "--preview-gap": `${itemGap}px` } as React.CSSProperties} aria-label={`Предпросмотр ${selectedPreview.label}`}>
      <div className="preview-menu"><header><b>{venue.name}</b><time>29.09.2026 13:57</time></header><div className="preview-items">{previewItems.map(item => <div className={`preview-item ${item.isAvailable ? "" : "unavailable"}`} key={item.id}><span>{item.name}</span><strong>{previewMoney.format(item.priceMinor / 100)}</strong></div>)}</div><small>Страница {previewPage + 1} из {expectedPages} · единый размер {fontSize}px</small></div>
      <div className="preview-break"><b>{testBreak ? "Перерыв" : "Проверка"}</b><strong>{testBreak ? "09:42" : "—"}</strong></div>
    </div>
    <div className="preview-controls"><button type="button" onClick={() => setPreviewPage(value => (value - 1 + expectedPages) % expectedPages)}>Предыдущая</button><button type="button" onClick={() => setPreviewPage(value => (value + 1) % expectedPages)}>Следующая</button><button type="button" onClick={() => setPaused(value => !value)}>{paused ? "Продолжить автоперелистывание" : "Пауза автоперелистывания"}</button><button type="button" onClick={() => setTestBreak(value => !value)}>{testBreak ? "Закрыть проверку перерыва" : "Проверить режим перерыва"}</button></div>
    <div className="experimental-actions"><button type="button" onClick={reset}>Вернуть рекомендуемые значения</button><button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Сохраняем…" : "Сохранить настройки"}</button></div>
    {message && <p className="settings-success">{message}</p>}{error && <p className="status-error">{error}</p>}
  </section>;
}

function RangeSetting({ label, value, unit, min, max, step, onChange }: { label: string; value: number; unit: string; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className="range-setting"><span>{label}<b>{value} {unit}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} /></label>;
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
        // Use the callback form: it also works in older WebKit builds where
        // qrcode's Promise-based overload is unavailable or unreliable.
        QRCode.toDataURL(pairingUrl, { margin: 2, width: 420 }, (qrError, dataUrl) => {
          if (cancelled) return;
          if (qrError) {
            setError(qrError instanceof Error ? qrError.message : "Не удалось нарисовать QR-код.");
            return;
          }
          setQr(dataUrl);
          setNow(Date.now());
          setExpiresAt(Date.now() + response.expiresInSeconds * 1000);
        });
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
  return <main className="status connect-screen"><section className="connect-card">
    <span className="auth-kicker">InteractiveFoodMenu</span><h1>Подключение телевизора</h1>
    {qr ? <><img src={qr} alt="QR-код подключения телевизора" /><p>Отсканируйте QR-код телефоном сотрудника и введите код точки и PIN.</p><p className={expired ? "pairing-expired" : "pairing-timer"}>{expired ? "Срок действия ключа истёк." : `До замены ключа: ${formatCountdown(secondsLeft)}`}</p>{expired && <button onClick={() => { setQr(""); setExpiresAt(null); setError(""); setRefreshKey(value => value + 1); }}>Обновить QR-код</button>}</> : <p>{error || "Создаём одноразовый QR-код…"}</p>}
  </section></main>;
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
  return <main className="auth-shell"><section className="auth-card staff-login"><span className="auth-kicker">InteractiveFoodMenu</span><h1>Подключение экрана</h1><p className="auth-lead">Введите данные точки, чтобы привязать этот телевизор.</p><label>Код точки<input autoComplete="username" placeholder="например, nevsky" value={code} onChange={e => setCode(e.target.value)} /></label><label>Шестизначный PIN<input autoComplete="current-password" placeholder="••••••" type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} /></label><button onClick={complete} disabled={busy || !token || pin.length !== 6}>{busy ? "Подключаем…" : "Подключить экран"}</button><small className="saved-credentials">После подключения экран будет получать обновления автоматически.</small><button className="link-button" onClick={() => { forgetVenueCredentials(); setCode(""); setPin(""); }}>Забыть сохранённые данные</button>{error && <p role="alert" className="status-error">{error}</p>}</section></main>;
}

function Status({ text, error = false }: { text: string; error?: boolean }) {
  return <main className={`status ${error ? "status-error" : ""}`}><p>{text}</p></main>;
}
