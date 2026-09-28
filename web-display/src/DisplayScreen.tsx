import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { autoScaleForMenu, layoutForViewport, paginateMenuByHeight } from "./paginate";
import type { Category, MenuItem, Venue } from "./types";
import { formatRussianText } from "./typography";
import { remainingBreakSeconds } from "./break";

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 });

function readViewport() {
  const visual = window.visualViewport;
  return { width: Math.round(visual?.width || document.documentElement.clientWidth || innerWidth), height: Math.round(visual?.height || document.documentElement.clientHeight || innerHeight) };
}

export function contrastForeground(hex: string) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return luminance > .45 ? "#201F1C" : "#FFFFFF";
}

function freshnessLabel(updatedAt: number | null) {
  if (!updatedAt) return "Нет связи · показано последнее меню";
  return `Нет связи · меню актуально на ${new Date(updatedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}`;
}

function formatLocalDateTime(now: number) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(now).replace(",", "");
}

export function DisplayScreen({ venue, categories, items, logoUrl, connected, updatedAt }: {
  venue: Venue; categories: Category[]; items: MenuItem[]; logoUrl: string; connected: boolean; updatedAt?: number | null;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [viewport, setViewport] = useState(readViewport);
  const [now, setNow] = useState(Date.now());
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const shellRef = useRef<HTMLElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const logoPosition = venue.logoPosition ?? "top-right";
  const logoInset = Math.min(20, Math.max(0, venue.logoInsetPercent ?? 3));
  const logoScale = Math.min(200, Math.max(50, venue.logoScalePercent ?? 100)) / 100;
  const backgroundColor = /^#[0-9a-f]{6}$/i.test(venue.backgroundColor) ? venue.backgroundColor : "#56965B";
  const accentColor = /^#[0-9a-f]{6}$/i.test(venue.accentColor) ? venue.accentColor : "#FFFFFF";
  const foregroundColor = contrastForeground(backgroundColor);
  const breakActive = venue.breakActive === true;
  const panelWidth = Math.min(50, Math.max(30, venue.breakPanelWidthPercent ?? 36));
  const dimPercent = Math.min(75, Math.max(25, venue.breakMenuDimPercent ?? 45));
  const itemFontSize = Math.min(54, Math.max(22, venue.menuItemFontSizePx ?? 34));
  const itemGap = Math.min(28, Math.max(4, venue.menuItemGapPx ?? 12));
  const transitionMs = Math.min(1200, Math.max(200, venue.breakTransitionMs ?? 600));
  const breakFontScale = Math.min(200, Math.max(50, venue.breakFontSizePercent ?? 100)) / 100;

  useEffect(() => {
    let timer = 0;
    const updateClock = () => {
      setNow(Date.now());
      timer = window.setTimeout(updateClock, 60_000 - Date.now() % 60_000 + 20);
    };
    timer = window.setTimeout(updateClock, 60_000 - Date.now() % 60_000 + 20);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const resize = () => setViewport(readViewport());
    addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => { removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); };
  }, []);

  // The break panel slides over the menu like a physical overlay. Keep menu
  // pagination and sizing stable while it is open.
  const usableWidth = viewport.width;
  const scale = useMemo(() => venue.displayScaleMode === "manual"
    ? Math.min(160, Math.max(50, venue.displayScalePercent ?? 100)) / 100
    : autoScaleForMenu(categories, items, usableWidth, viewport.height), [venue.displayScaleMode, venue.displayScalePercent, categories, items, usableWidth, viewport.height]);
  const layout = useMemo(() => layoutForViewport(usableWidth / scale, viewport.height / scale, viewport.height / scale), [usableWidth, viewport.height, scale]);
  const availableHeight = Math.max(180, viewport.height / scale - 190);
  const columnWidth = Math.max(220, (usableWidth / scale - Math.max(0, layout.columnCount - 1) * 32) / layout.columnCount);

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    const next: Record<string, number> = {};
    root.querySelectorAll<HTMLElement>("[data-measure-key]").forEach((element) => { next[element.dataset.measureKey ?? ""] = Math.ceil(element.getBoundingClientRect().height); });
    setMeasuredHeights((current) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key])) return current;
      return next;
    });
  }, [categories, items, columnWidth, itemFontSize, itemGap, scale]);

  const pages = useMemo(() => paginateMenuByHeight(categories, items, availableHeight, layout.columnCount, {
    category: measuredHeights.category ?? 52,
    item: (item) => measuredHeights[`item-${item.id}`] ?? itemFontSize * 1.4 + itemGap * 2,
  }), [categories, items, availableHeight, layout.columnCount, measuredHeights, itemFontSize, itemGap]);

  useEffect(() => { setPageIndex(0); }, [breakActive]);
  useEffect(() => {
    setPageIndex((current) => pages.length ? Math.min(current, pages.length - 1) : 0);
    if (pages.length <= 1) return;
    const timer = window.setInterval(() => setPageIndex((current) => (current + 1) % pages.length), Math.min(30, Math.max(5, venue.pageDurationSeconds || 10)) * 1000);
    return () => window.clearInterval(timer);
  }, [pages.length, venue.pageDurationSeconds]);

  const page = pages[pageIndex];
  const style = {
    backgroundColor, color: foregroundColor, "--background": backgroundColor, "--accent": accentColor, "--foreground": foregroundColor,
    "--logo-inset": `${logoInset}%`, "--logo-scale": logoScale, "--break-panel-width": `${panelWidth}%`,
    "--menu-dim-opacity": (100 - dimPercent) / 100, "--item-font-size": `${itemFontSize}px`, "--item-gap": `${itemGap}px`, "--break-transition": `${transitionMs}ms`,
  } as React.CSSProperties;

  return <main ref={shellRef} className={`display-shell ${breakActive ? "break-active" : ""}`} lang="ru" style={style}>
    <section className={`display-menu logo-${logoPosition}`} style={{ zoom: scale }}>
      <header className="display-header"><h1 style={{ color: accentColor }}>{formatRussianText(venue.name)}</h1><div className="display-header-meta"><time className="display-clock" dateTime={new Date(now).toISOString()}>{formatLocalDateTime(now)}</time>{pages.length > 1 && <span className="page-indicator" aria-live="polite" aria-label={`Страница ${pageIndex + 1} из ${pages.length}`}>{pageIndex + 1} / {pages.length}</span>}</div></header>
      {logoUrl && venue.logoVisible !== false && <img className="logo" src={logoUrl} alt="Логотип точки" />}
      {!page ? <div className="empty">Меню пока не заполнено</div> : <section className="page page-transition" key={`${pageIndex}-${items.length}-${breakActive}`} style={{ gridTemplateColumns: `repeat(${page.columns.length}, minmax(0, 1fr))` }}>
        {page.columns.map((column, columnIndex) => <div className="column" key={columnIndex}>{column.map((entry, rowIndex) => entry.kind === "category" ?
          <h2 className={`menu-heading ${venue.showServingSize ? "has-serving" : ""} ${venue.showCalories ? "has-calories" : ""}`} key={`${entry.categoryId}-${rowIndex}`} style={{ color: accentColor, borderBottomColor: accentColor }}><span>{formatRussianText(entry.name)}{entry.repeated && <span className="continued"> · продолжение</span>}</span><span className="menu-column-labels" aria-hidden="true">{venue.showServingSize && <span>Выход</span>}<span>Цена</span>{venue.showCalories && <span>Ккал</span>}</span></h2> :
          <div className={`menu-item menu-item-enter ${venue.showServingSize ? "has-serving" : ""} ${venue.showCalories ? "has-calories" : ""} ${entry.item.isAvailable ? "" : "unavailable"}`} key={entry.item.id} style={{ "--row-delay": `${Math.min(rowIndex, 12) * 35}ms` } as React.CSSProperties}><span className="item-name">{formatRussianText(entry.item.name)}</span><span className="dots" />{venue.showServingSize && <span className="serving-size">{entry.item.servingSize || "—"}</span>}<span className="price">{money.format(entry.item.priceMinor / 100)}</span>{venue.showCalories && <span className="calories">{entry.item.caloriesKcal ?? "—"}</span>}</div>)}</div>)}
      </section>}
      <footer>{!connected ? <span className="connection offline">{freshnessLabel(updatedAt ?? null)}</span> : <span />}</footer>
    </section>
    <BreakPanel active={breakActive} endsAt={venue.breakEndsAt} expiredText={venue.breakExpiredText ?? "Скоро буду"} fontScale={breakFontScale} panelWidth={panelWidth} viewport={viewport} />
    <div ref={measureRef} className="menu-measure" aria-hidden="true" style={{ width: columnWidth, fontSize: itemFontSize }}><h2 data-measure-key="category">Раздел</h2>{items.map((item) => <div className={`menu-item ${venue.showServingSize ? "has-serving" : ""} ${venue.showCalories ? "has-calories" : ""}`} data-measure-key={`item-${item.id}`} key={item.id}><span className="item-name">{formatRussianText(item.name)}</span><span className="dots" />{venue.showServingSize && <span className="serving-size">{item.servingSize || "—"}</span>}<span className="price">{money.format(item.priceMinor / 100)}</span>{venue.showCalories && <span className="calories">{item.caloriesKcal ?? "—"}</span>}</div>)}</div>
  </main>;
}

function BreakPanel({ active, endsAt, expiredText, fontScale, panelWidth, viewport }: {
  active: boolean; endsAt?: string | null; expiredText: string; fontScale: number; panelWidth: number; viewport: { width: number; height: number };
}) {
  const [now, setNow] = useState(Date.now());
  const seconds = remainingBreakSeconds(active, endsAt, now);
  const expired = active && seconds === 0;

  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      timer = window.setTimeout(tick, 1000 - current % 1000 + 12);
    };
    timer = window.setTimeout(tick, 0);
    return () => window.clearTimeout(timer);
  }, [active, endsAt]);

  return <aside className={`break-panel ${expired ? "break-expired" : ""}`} aria-hidden={!active} aria-live="polite"><div className="break-state-label">{expired ? "Перерыв завершён" : "Перерыв"}</div>{expired ? <strong className="break-expired-text">{formatRussianText(expiredText)}</strong> : <strong className="break-timer" style={{ fontSize: `${Math.max(38, Math.min(118 * fontScale, viewport.width * panelWidth / 100 * .34, viewport.height * .3))}px` }}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</strong>}</aside>;
}
