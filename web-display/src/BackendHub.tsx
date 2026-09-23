import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { clampInteger, logoPositions, normalizeVenueAppearance, polytechAppearance, type LogoPosition, type VenueAppearance } from "./venueSettings";

type HubOverview = {
  generatedAt: string;
  totals: { venues: number; categories: number; items: number; activeDisplays: number };
  venues: HubVenue[];
  functions: Array<{ name: string; area: string; access: string; purpose: string }>;
  clientLogs: Array<{ id: string; venueId: string; role: string; level: string; event: string; message: string; createdAt: string | null }>;
  auditLogs: Array<{ id: string; action: string; venueId: string; createdAt: string | null }>;
};

type HubVenue = {
  id: string;
  name: string;
  code: string;
  backgroundColor: string;
  accentColor: string;
  pageDurationSeconds: number;
  displayScalePercent: number;
  logoFileId?: string | null;
  logoPosition?: LogoPosition;
  staffVersion: number;
  displayVersion: number;
  updatedAt: string | null;
};

function hubInstallationId() {
  const storageKey = "backend-hub-installation-id";
  const stored = localStorage.getItem(storageKey);
  if (stored) return stored;
  const value = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `hub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(storageKey, value);
  return value;
}

function errorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "Операция не выполнена.";
  return message.replace(/\s*\(functions\/[a-z-]+\)\.?$/i, "");
}

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString("ru-RU") : "—";
}

function HubVenueSettings({ venue, busy, onSave, onUploadLogo, onUseDefaultLogo, onClose }: {
  venue: HubVenue;
  busy: boolean;
  onSave: (settings: VenueAppearance) => Promise<void>;
  onUploadLogo: (file: File) => Promise<void>;
  onUseDefaultLogo: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(venue.name);
  const [backgroundColor, setBackgroundColor] = useState(venue.backgroundColor);
  const [accentColor, setAccentColor] = useState(venue.accentColor);
  const [duration, setDuration] = useState(venue.pageDurationSeconds);
  const [displayScale, setDisplayScale] = useState(venue.displayScalePercent);
  const [logoPosition, setLogoPosition] = useState<LogoPosition>(venue.logoPosition ?? "top-right");
  const [error, setError] = useState("");

  useEffect(() => {
    setName(venue.name); setBackgroundColor(venue.backgroundColor); setAccentColor(venue.accentColor);
    setDuration(venue.pageDurationSeconds); setDisplayScale(venue.displayScalePercent); setLogoPosition(venue.logoPosition ?? "top-right"); setError("");
  }, [venue]);

  const save = async () => {
    try {
      setError("");
      await onSave(normalizeVenueAppearance({ name, backgroundColor, accentColor, pageDurationSeconds: duration, displayScalePercent: displayScale, logoPosition }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки."); }
  };

  return <section className="hub-venue-settings">
    <div className="hub-card-title"><h3>Оформление: {venue.name}</h3><button onClick={onClose}>Закрыть</button></div>
    <label>Название точки<input maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
    <HubColorField label="Цвет фона" value={backgroundColor} onChange={setBackgroundColor} />
    <HubColorField label="Цвет текста и заголовков" value={accentColor} onChange={setAccentColor} />
    <HubNumberControl label="Смена страниц, сек." value={duration} minimum={5} maximum={60} step={1} onChange={setDuration} />
    <HubNumberControl label="Масштаб меню ТВ, %" value={displayScale} minimum={50} maximum={160} step={5} onChange={setDisplayScale} />
    <label>Расположение логотипа<select value={logoPosition} onChange={event => setLogoPosition(event.target.value as LogoPosition)}>{logoPositions.map(position => <option key={position} value={position}>{({ "top-right": "Справа сверху", "top-left": "Слева сверху", "bottom-right": "Справа снизу", "bottom-left": "Слева снизу" } as Record<LogoPosition, string>)[position]}</option>)}</select></label>
    <div className="hub-logo-controls"><b>Логотип</b><span>{venue.logoFileId ? "Загруженный логотип" : "Стандартный белый логотип Политеха"}</span><label className="hub-upload-button">Загрузить свой<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void onUploadLogo(file).catch(cause => setError(cause instanceof Error ? cause.message : "Не удалось загрузить логотип.")); event.currentTarget.value = ""; }} /></label>{venue.logoFileId && <button type="button" disabled={busy} onClick={() => void onUseDefaultLogo().catch(cause => setError(cause instanceof Error ? cause.message : "Не удалось восстановить логотип."))}>Стандартный логотип</button>}</div>
    <div className="hub-settings-actions"><button type="button" onClick={() => { setBackgroundColor(polytechAppearance.backgroundColor); setAccentColor(polytechAppearance.accentColor); }}>Цвета Политеха</button><button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Сохраняем…" : "Сохранить"}</button></div>
    {error && <p className="hub-error">{error}</p>}
  </section>;
}

function HubColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const color = /^#[0-9a-f]{6}$/i.test(value) ? value : "#FFFFFF";
  return <label>{label}<span className="hub-color"><input aria-label={`${label}: выбрать`} type="color" value={color} onChange={event => onChange(event.target.value.toUpperCase())} /><input aria-label={`${label}: HEX`} maxLength={7} value={value} onChange={event => onChange(event.target.value)} /></span></label>;
}

function HubNumberControl({ label, value, minimum, maximum, step, onChange }: { label: string; value: number; minimum: number; maximum: number; step: number; onChange: (value: number) => void }) {
  return <label>{label}<span className="hub-number"><button type="button" aria-label={`${label}: уменьшить`} disabled={value <= minimum} onClick={() => onChange(Math.max(minimum, value - step))}>−</button><input type="number" min={minimum} max={maximum} step={step} value={value} onChange={event => onChange(clampInteger(event.target.value, minimum, maximum, value))} /><button type="button" aria-label={`${label}: увеличить`} disabled={value >= maximum} onClick={() => onChange(Math.min(maximum, value + step))}>+</button></span></label>;
}

export function BackendHub() {
  const [hubToken, setHubToken] = useState(() => localStorage.getItem("ifm-hub-session") ?? "");
  const [accessKey, setAccessKey] = useState("");
  const [overview, setOverview] = useState<HubOverview | null>(null);
  const [tab, setTab] = useState<"venues" | "functions" | "logs" | "audit">("venues");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newVenue, setNewVenue] = useState({ venueCode: "", name: "", pin: "" });
  const [createdDisplayUrl, setCreatedDisplayUrl] = useState("");
  const [editingVenueId, setEditingVenueId] = useState("");

  const loadOverview = useCallback(async () => {
    setBusy(true); setError("");
    try {
      setOverview(await api.hubOverview(hubToken) as HubOverview);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }, [hubToken]);

  useEffect(() => { if (hubToken) void loadOverview(); }, [hubToken, loadOverview]);

  const login = async () => {
    setBusy(true); setError("");
    try {
      const response = await api.hubLogin(accessKey);
      localStorage.setItem("ifm-hub-session", response.token);
      setHubToken(response.token);
      setAccessKey("");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  const createVenue = async () => {
    setBusy(true); setError(""); setNotice(""); setCreatedDisplayUrl("");
    try {
      const response = await api.hubCreateVenue(hubToken, newVenue);
      setCreatedDisplayUrl(response.displayUrl);
      setNotice(`Точка «${newVenue.name}» создана.`);
      setNewVenue({ venueCode: "", name: "", pin: "" });
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };

  const rotatePin = async (venueId: string, currentCode: string) => {
    const venueCode = window.prompt("Код точки", currentCode)?.trim().toLowerCase();
    if (!venueCode) return;
    const pin = window.prompt("Новый шестизначный PIN") ?? "";
    if (!/^\d{6}$/.test(pin)) { setError("PIN должен состоять из шести цифр."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await api.hubRotatePin(hubToken, venueId, venueCode, pin);
      setNotice("Код и PIN обновлены. Предыдущие сессии сотрудников отозваны.");
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };

  const revokeSessions = async (venueId: string) => {
    if (!window.confirm("Отозвать все сессии сотрудников и экранов этой точки? Экраны потребуется подключить заново.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.hubRevoke(hubToken, venueId);
      setNotice("Все сессии точки отозваны.");
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };

  const deleteVenue = async (venueId: string, name: string) => {
    if (!window.confirm(`Полностью удалить точку «${name}», её меню, ссылки экранов и журналы? Это действие нельзя отменить.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.hubDeleteVenue(hubToken, venueId);
      setNotice(`Точка «${name}» полностью удалена.`);
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };

  const saveVenueSettings = async (venueId: string, settings: VenueAppearance) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await api.hubUpdateVenue(hubToken, venueId, settings);
      setNotice("Настройки точки сохранены. Экран применит их при следующем обновлении.");
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };

  const uploadVenueLogo = async (venueId: string, file: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Выберите PNG, JPEG или WebP.");
    if (file.size > 5 * 1024 * 1024) throw new Error("Размер логотипа должен быть не больше 5 МБ.");
    setBusy(true); setError(""); setNotice("");
    try {
      await api.hubUploadVenueLogo(hubToken, venueId, file);
      setNotice("Логотип загружен.");
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); throw cause; }
  };

  const useDefaultLogo = async (venueId: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await api.hubUpdateVenue(hubToken, venueId, { logoFileId: null });
      setNotice("Восстановлен стандартный логотип Политеха.");
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); throw cause; }
  };

  const groupedFunctions = useMemo(() => {
    const groups = new Map<string, HubOverview["functions"]>();
    overview?.functions.forEach(entry => groups.set(entry.area, [...(groups.get(entry.area) ?? []), entry]));
    return Array.from(groups.entries());
  }, [overview]);
  const editingVenue = overview?.venues.find(venue => venue.id === editingVenueId) ?? null;

  if (!hubToken) return <main className="hub-login">
    <div className="hub-login-card"><span className="hub-kicker">InteractiveFoodMenu</span><h1>Backend Hub</h1><p>Единый центр управления серверной частью.</p><input type="password" autoComplete="current-password" placeholder="Ключ оператора" value={accessKey} onChange={event => setAccessKey(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void login(); }} /><button disabled={busy || !accessKey} onClick={() => void login()}>{busy ? "Проверяем…" : "Войти в хаб"}</button>{error && <p className="hub-error">{error}</p>}</div>
  </main>;

  return <main className="backend-hub">
    <aside className="hub-sidebar"><div><span className="hub-kicker">InteractiveFoodMenu</span><h1>Backend Hub</h1></div><nav>{([ ["venues", "Точки"], ["functions", "Функции"], ["logs", "Ошибки клиентов"], ["audit", "Действия"] ] as const).map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav><button className="hub-signout" onClick={() => { localStorage.removeItem("ifm-hub-session"); setHubToken(""); setOverview(null); }}>Выйти</button></aside>
    <section className="hub-content">
      <header className="hub-header"><div><span className="hub-kicker">Управление платформой</span><h2>{tab === "venues" ? "Точки и доступ" : tab === "functions" ? "Серверные функции" : tab === "logs" ? "Ошибки клиентов" : "Журнал действий"}</h2></div><button className="hub-refresh" disabled={busy} onClick={() => void loadOverview()}>{busy ? "Обновляем…" : "Обновить"}</button></header>
      {error && <p className="hub-banner hub-error">{error}</p>}{notice && <p className="hub-banner hub-success">{notice}</p>}
      {overview && <>
        <div className="hub-metrics"><article><small>Точек</small><strong>{overview.totals.venues}</strong></article><article><small>Категорий</small><strong>{overview.totals.categories}</strong></article><article><small>Позиций</small><strong>{overview.totals.items}</strong></article><article><small>Активных экранов</small><strong>{overview.totals.activeDisplays}</strong></article></div>
        {tab === "venues" && <div className="hub-grid">
          <section className="hub-card"><div className="hub-card-title"><h3>Все точки</h3><small>{overview.venues.length} из {overview.totals.venues}</small></div><div className="hub-table-wrap"><table><thead><tr><th>Точка</th><th>Код</th><th>Версии</th><th>Обновлена</th><th></th></tr></thead><tbody>{overview.venues.map(venue => <tr key={venue.id}><td><b>{venue.name}</b><small>{venue.id}</small></td><td><code>{venue.code || "—"}</code></td><td><small>staff {venue.staffVersion} · display {venue.displayVersion}</small></td><td>{dateTime(venue.updatedAt)}</td><td className="hub-actions"><button onClick={() => setEditingVenueId(venue.id)}>Оформление</button><button onClick={() => void rotatePin(venue.id, venue.code)}>Сменить PIN</button><button className="danger" onClick={() => void revokeSessions(venue.id)}>Отозвать</button><button className="danger" onClick={() => void deleteVenue(venue.id, venue.name)}>Удалить</button></td></tr>)}</tbody></table></div>{editingVenue && <HubVenueSettings venue={editingVenue} busy={busy} onClose={() => setEditingVenueId("")} onSave={settings => saveVenueSettings(editingVenue.id, settings)} onUploadLogo={file => uploadVenueLogo(editingVenue.id, file)} onUseDefaultLogo={() => useDefaultLogo(editingVenue.id)} />}</section>
          <section className="hub-card hub-create"><h3>Новая точка</h3><label>Название<input placeholder="Кофейня на Невском" value={newVenue.name} onChange={event => setNewVenue({ ...newVenue, name: event.target.value })} /></label><label>Код для входа<input placeholder="nevsky" pattern="[a-z0-9-]{3,32}" value={newVenue.venueCode} onChange={event => setNewVenue({ ...newVenue, venueCode: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} /><small>3–32 латинских символа, цифры или дефис.</small></label><label>PIN<input type="password" inputMode="numeric" maxLength={6} placeholder="6 цифр" value={newVenue.pin} onChange={event => setNewVenue({ ...newVenue, pin: event.target.value.replace(/\D/g, "") })} /></label><button disabled={busy || !newVenue.name || newVenue.venueCode.length < 3 || newVenue.pin.length !== 6} onClick={() => void createVenue()}>Создать точку</button>{createdDisplayUrl && <div className="hub-secret"><b>Ссылка первого экрана</b><p>Она показывается только сейчас. Сохраните её безопасно.</p><textarea readOnly value={createdDisplayUrl} /><button onClick={() => void navigator.clipboard.writeText(createdDisplayUrl)}>Скопировать</button></div>}</section>
        </div>}
        {tab === "functions" && <div className="hub-function-groups">{groupedFunctions.map(([area, entries]) => <section className="hub-card" key={area}><div className="hub-card-title"><h3>{area}</h3><small>{entries.length}</small></div>{entries.map(entry => <article className="hub-function" key={entry.name}><div><code>{entry.name}</code><p>{entry.purpose}</p></div><span>{entry.access}</span></article>)}</section>)}</div>}
        {tab === "logs" && <section className="hub-card"><div className="hub-card-title"><h3>Последние события</h3><small>до 30 записей</small></div><div className="hub-log-list">{overview.clientLogs.length ? overview.clientLogs.map(entry => <article key={entry.id} className={`hub-log ${entry.level}`}><div><b>{entry.event}</b><span>{entry.venueId} · {entry.role}</span></div><p>{entry.message || "Без описания"}</p><time>{dateTime(entry.createdAt)}</time></article>) : <p className="hub-empty">Ошибок пока нет.</p>}</div></section>}
        {tab === "audit" && <section className="hub-card"><div className="hub-card-title"><h3>Операторские действия</h3><small>до 20 записей</small></div><div className="hub-log-list">{overview.auditLogs.length ? overview.auditLogs.map(entry => <article key={entry.id} className="hub-log"><div><b>{entry.action}</b><span>{entry.venueId}</span></div><time>{dateTime(entry.createdAt)}</time></article>) : <p className="hub-empty">Действий пока нет.</p>}</div></section>}
      </>}
    </section>
  </main>;
}
