import { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithCustomToken } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "./firebase";

type HubOverview = {
  generatedAt: string;
  totals: { venues: number; categories: number; items: number; activeDisplays: number };
  venues: Array<{ id: string; name: string; code: string; staffVersion: number; displayVersion: number; updatedAt: string | null }>;
  functions: Array<{ name: string; area: string; access: string; purpose: string }>;
  clientLogs: Array<{ id: string; venueId: string; role: string; level: string; event: string; message: string; createdAt: string | null }>;
  auditLogs: Array<{ id: string; action: string; venueId: string; createdAt: string | null }>;
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
  return message.replace(/^Firebase:\s*/i, "").replace(/\s*\(functions\/[a-z-]+\)\.?$/i, "");
}

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString("ru-RU") : "—";
}

export function BackendHub() {
  const [authorized, setAuthorized] = useState(false);
  const [ready, setReady] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [overview, setOverview] = useState<HubOverview | null>(null);
  const [tab, setTab] = useState<"venues" | "functions" | "logs" | "audit">("venues");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newVenue, setNewVenue] = useState({ venueId: "", venueCode: "", name: "", pin: "" });
  const [createdDisplayUrl, setCreatedDisplayUrl] = useState("");

  const loadOverview = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const call = httpsCallable<Record<string, never>, HubOverview>(functions, "getBackendHubOverview");
      const response = await call({});
      setOverview(response.data);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const fallback = window.setTimeout(() => setReady(true), 1500);
    const unsubscribe = onAuthStateChanged(auth, async user => {
      window.clearTimeout(fallback);
    if (!user) { setAuthorized(false); setReady(true); return; }
    const token = await user.getIdTokenResult();
    const isHubAdmin = token.claims.role === "platform_admin";
    setAuthorized(isHubAdmin); setReady(true);
    if (isHubAdmin) void loadOverview();
    });
    return () => { window.clearTimeout(fallback); unsubscribe(); };
  }, [loadOverview]);

  const login = async () => {
    setBusy(true); setError("");
    try {
      const call = httpsCallable<{ accessKey: string; installationId: string }, { customToken: string }>(functions, "loginBackendHub");
      const response = await call({ accessKey, installationId: hubInstallationId() });
      await signInWithCustomToken(auth, response.data.customToken);
      setAccessKey("");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  const createVenue = async () => {
    setBusy(true); setError(""); setNotice(""); setCreatedDisplayUrl("");
    try {
      const call = httpsCallable<typeof newVenue, { venueId: string; displayUrl: string }>(functions, "createVenueFromHub");
      const response = await call(newVenue);
      setCreatedDisplayUrl(response.data.displayUrl);
      setNotice(`Точка «${newVenue.name}» создана.`);
      setNewVenue({ venueId: "", venueCode: "", name: "", pin: "" });
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
      const call = httpsCallable<{ venueId: string; venueCode: string; pin: string }, { updated: boolean }>(functions, "rotateVenuePinFromHub");
      await call({ venueId, venueCode, pin });
      setNotice("Код и PIN обновлены. Предыдущие сессии сотрудников отозваны.");
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };

  const revokeSessions = async (venueId: string) => {
    if (!window.confirm("Отозвать все сессии сотрудников и экранов этой точки? Экраны потребуется подключить заново.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const call = httpsCallable<{ venueId: string; scope: "all" }, { revoked: boolean }>(functions, "revokeVenueSessionsFromHub");
      await call({ venueId, scope: "all" });
      setNotice("Все сессии точки отозваны.");
      await loadOverview();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };

  const groupedFunctions = useMemo(() => {
    const groups = new Map<string, HubOverview["functions"]>();
    overview?.functions.forEach(entry => groups.set(entry.area, [...(groups.get(entry.area) ?? []), entry]));
    return Array.from(groups.entries());
  }, [overview]);

  if (!ready) return <main className="hub-login"><p>Проверяем доступ…</p></main>;
  if (!authorized) return <main className="hub-login">
    <div className="hub-login-card"><span className="hub-kicker">InteractiveFoodMenu</span><h1>Backend Hub</h1><p>Единый центр управления серверной частью.</p><input type="password" autoComplete="current-password" placeholder="Ключ оператора" value={accessKey} onChange={event => setAccessKey(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void login(); }} /><button disabled={busy || !accessKey} onClick={() => void login()}>{busy ? "Проверяем…" : "Войти в хаб"}</button>{error && <p className="hub-error">{error}</p>}</div>
  </main>;

  return <main className="backend-hub">
    <aside className="hub-sidebar"><div><span className="hub-kicker">InteractiveFoodMenu</span><h1>Backend Hub</h1></div><nav>{([ ["venues", "Точки"], ["functions", "Функции"], ["logs", "Ошибки клиентов"], ["audit", "Действия"] ] as const).map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav><button className="hub-signout" onClick={() => void auth.signOut()}>Выйти</button></aside>
    <section className="hub-content">
      <header className="hub-header"><div><span className="hub-kicker">Управление платформой</span><h2>{tab === "venues" ? "Точки и доступ" : tab === "functions" ? "Серверные функции" : tab === "logs" ? "Ошибки клиентов" : "Журнал действий"}</h2></div><button className="hub-refresh" disabled={busy} onClick={() => void loadOverview()}>{busy ? "Обновляем…" : "Обновить"}</button></header>
      {error && <p className="hub-banner hub-error">{error}</p>}{notice && <p className="hub-banner hub-success">{notice}</p>}
      {overview && <>
        <div className="hub-metrics"><article><small>Точек</small><strong>{overview.totals.venues}</strong></article><article><small>Категорий</small><strong>{overview.totals.categories}</strong></article><article><small>Позиций</small><strong>{overview.totals.items}</strong></article><article><small>Активных экранов</small><strong>{overview.totals.activeDisplays}</strong></article></div>
        {tab === "venues" && <div className="hub-grid">
          <section className="hub-card"><div className="hub-card-title"><h3>Все точки</h3><small>{overview.venues.length} из {overview.totals.venues}</small></div><div className="hub-table-wrap"><table><thead><tr><th>Точка</th><th>Код</th><th>Версии</th><th>Обновлена</th><th></th></tr></thead><tbody>{overview.venues.map(venue => <tr key={venue.id}><td><b>{venue.name}</b><small>{venue.id}</small></td><td><code>{venue.code || "—"}</code></td><td><small>staff {venue.staffVersion} · display {venue.displayVersion}</small></td><td>{dateTime(venue.updatedAt)}</td><td className="hub-actions"><button onClick={() => void rotatePin(venue.id, venue.code)}>Сменить PIN</button><button className="danger" onClick={() => void revokeSessions(venue.id)}>Отозвать</button></td></tr>)}</tbody></table></div></section>
          <section className="hub-card hub-create"><h3>Новая точка</h3><label>ID<input placeholder="coffee-nevsky" value={newVenue.venueId} onChange={event => setNewVenue({ ...newVenue, venueId: event.target.value.toLowerCase() })} /></label><label>Название<input placeholder="Кофейня на Невском" value={newVenue.name} onChange={event => setNewVenue({ ...newVenue, name: event.target.value })} /></label><label>Код для входа<input placeholder="nevsky" value={newVenue.venueCode} onChange={event => setNewVenue({ ...newVenue, venueCode: event.target.value.toLowerCase() })} /></label><label>PIN<input type="password" inputMode="numeric" maxLength={6} placeholder="6 цифр" value={newVenue.pin} onChange={event => setNewVenue({ ...newVenue, pin: event.target.value.replace(/\D/g, "") })} /></label><button disabled={busy || !newVenue.venueId || !newVenue.name || !newVenue.venueCode || newVenue.pin.length !== 6} onClick={() => void createVenue()}>Создать точку</button>{createdDisplayUrl && <div className="hub-secret"><b>Ссылка первого экрана</b><p>Она показывается только сейчас. Сохраните её безопасно.</p><textarea readOnly value={createdDisplayUrl} /><button onClick={() => void navigator.clipboard.writeText(createdDisplayUrl)}>Скопировать</button></div>}</section>
        </div>}
        {tab === "functions" && <div className="hub-function-groups">{groupedFunctions.map(([area, entries]) => <section className="hub-card" key={area}><div className="hub-card-title"><h3>{area}</h3><small>{entries.length}</small></div>{entries.map(entry => <article className="hub-function" key={entry.name}><div><code>{entry.name}</code><p>{entry.purpose}</p></div><span>{entry.access}</span></article>)}</section>)}</div>}
        {tab === "logs" && <section className="hub-card"><div className="hub-card-title"><h3>Последние события</h3><small>до 30 записей</small></div><div className="hub-log-list">{overview.clientLogs.length ? overview.clientLogs.map(entry => <article key={entry.id} className={`hub-log ${entry.level}`}><div><b>{entry.event}</b><span>{entry.venueId} · {entry.role}</span></div><p>{entry.message || "Без описания"}</p><time>{dateTime(entry.createdAt)}</time></article>) : <p className="hub-empty">Ошибок пока нет.</p>}</div></section>}
        {tab === "audit" && <section className="hub-card"><div className="hub-card-title"><h3>Операторские действия</h3><small>до 20 записей</small></div><div className="hub-log-list">{overview.auditLogs.length ? overview.auditLogs.map(entry => <article key={entry.id} className="hub-log"><div><b>{entry.action}</b><span>{entry.venueId}</span></div><time>{dateTime(entry.createdAt)}</time></article>) : <p className="hub-empty">Действий пока нет.</p>}</div></section>}
      </>}
    </section>
  </main>;
}
