import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Epoch = { id: string; startedAt: string | null; endedAt: string | null };
type Report = { venueId: string; from: string; to: string; epochId: string; epochs: Epoch[]; counts: Record<string, number> };
type Venue = { id: string; name: string };

function moscowToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function daysBefore(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
function epochLabel(epoch: Epoch) {
  return epoch.startedAt ? `После сброса ${new Date(epoch.startedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}` : "Исходный период";
}
function moscowDate(value: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function HubStatistics({ token, venues }: { token: string; venues: Venue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? "");
  const [preset, setPreset] = useState("30");
  const [to, setTo] = useState(moscowToday);
  const [from, setFrom] = useState(() => daysBefore(moscowToday(), 29));
  const [epochId, setEpochId] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const resetLock = useRef(false);
  const selectedVenue = venues.find(venue => venue.id === venueId);

  useEffect(() => {
    if (!venueId && venues[0]) setVenueId(venues[0].id);
  }, [venueId, venues]);
  useEffect(() => {
    if (!venueId) return;
    let active = true;
    setBusy(true); setError("");
    api.hubStatistics(token, venueId, from, to, epochId || undefined)
      .then(value => { if (active) { setReport(value as Report); setBusy(false); } })
      .catch(cause => { if (active) { setError(cause instanceof Error ? cause.message : "Не удалось загрузить статистику."); setBusy(false); } });
    return () => { active = false; };
  }, [token, venueId, from, to, epochId, revision]);

  const selectPreset = (value: string) => {
    setPreset(value);
    if (value !== "custom") { const today = moscowToday(); setTo(today); setFrom(daysBefore(today, Number(value) - 1)); }
  };
  const selectEpoch = (value: string) => {
    setEpochId(value);
    const epoch = report?.epochs.find(item => item.id === value);
    if (epoch) {
      setPreset("custom");
      const end = epoch.endedAt ? moscowDate(epoch.endedAt) : moscowToday();
      const earliest = daysBefore(end, 365);
      const started = epoch.startedAt ? moscowDate(epoch.startedAt) : earliest;
      setFrom(started > earliest ? started : earliest);
      setTo(end);
    }
  };
  const reset = async () => {
    if (resetLock.current || !selectedVenue || !window.confirm(`Начать новый период статистики точки «${selectedVenue.name}»? Прошлые периоды останутся доступны.`)) return;
    resetLock.current = true;
    setBusy(true); setError("");
    try { await api.hubResetStatistics(token, venueId); setEpochId(""); setRevision(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сбросить статистику."); setBusy(false); }
    finally { resetLock.current = false; }
  };
  const cards: Array<[string, string]> = [
    ["menuChanges", "Изменений меню"], ["availabilityChanges", "Изменений наличия"], ["stockChanges", "Изменений остатка"],
    ["staffLogins", "Входов сотрудников"], ["displayConnections", "Подключений экранов"],
    ["displayContactIntervals", "Интервалов связи с экранами"], ["errors", "Ошибок клиентов"],
  ];

  return <section className="hub-card hub-statistics">
    <div className="hub-card-title"><div><h3>Статистика точки</h3><small>Дни считаются по московскому времени. Интервал связи — 15 минут с хотя бы одним обращением экрана.</small></div></div>
    <div className="hub-statistics-controls">
      <label>Точка<select value={venueId} onChange={event => { setVenueId(event.target.value); setEpochId(""); }}>{venues.map(venue => <option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label>
      <label>Период<select value={preset} onChange={event => selectPreset(event.target.value)}><option value="1">Сегодня</option><option value="7">7 дней</option><option value="30">30 дней</option><option value="custom">Свои даты</option></select></label>
      {preset === "custom" && <><label>С<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>По<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label></>}
      <label>История<select value={epochId} onChange={event => selectEpoch(event.target.value)}><option value="">Текущий период</option>{report?.epochs.filter(epoch => epoch.id !== report.epochs[report.epochs.length - 1]?.id).map(epoch => <option key={epoch.id} value={epoch.id}>{epochLabel(epoch)}</option>)}</select></label>
    </div>
    {error && <p className="hub-error" role="alert">{error}</p>}
    {busy && <p role="status">Загружаем статистику…</p>}
    {report && <><p className="hub-statistics-range">{report.from} — {report.to}{epochId ? " · архивный период" : ""}</p><div className="hub-statistics-grid">{cards.map(([key, label]) => <article key={key}><small>{label}</small><strong>{report.counts[key] ?? 0}</strong></article>)}</div></>}
    <div className="hub-settings-actions"><button type="button" className="danger" disabled={!venueId || busy || Boolean(epochId)} onClick={() => void reset()}>Начать новый период статистики</button></div>
  </section>;
}
