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
  const [morphActive, setMorphActive] = useState(false);
  const shellRef = useRef<HTMLElement | null>(null);
  const clockRef = useRef<HTMLTimeElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<HTMLElement | null>(null);
  const morphRef = useRef<HTMLSpanElement | null>(null);
  const lastClockRect = useRef<DOMRect | null>(null);
  const previousBreakActive = useRef<boolean | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const logoPosition = venue.logoPosition ?? "top-right";
  const logoInset = Math.min(20, Math.max(0, venue.logoInsetPercent ?? 3));
  const logoScale = Math.min(200, Math.max(50, venue.logoScalePercent ?? 100)) / 100;
  const backgroundColor = /^#[0-9a-f]{6}$/i.test(venue.backgroundColor) ? venue.backgroundColor : "#56965B";
  const accentColor = /^#[0-9a-f]{6}$/i.test(venue.accentColor) ? venue.accentColor : "#FFFFFF";
  const foregroundColor = contrastForeground(backgroundColor);
  const breakActive = venue.breakActive === true;
  const breakSeconds = remainingBreakSeconds(breakActive, venue.breakEndsAt, now);
  const breakExpired = breakActive && breakSeconds === 0;
  const panelWidth = Math.min(50, Math.max(30, venue.breakPanelWidthPercent ?? 36));
  const dimPercent = Math.min(75, Math.max(25, venue.breakMenuDimPercent ?? 45));
  const itemFontSize = Math.min(54, Math.max(22, venue.menuItemFontSizePx ?? 34));
  const itemGap = Math.min(28, Math.max(4, venue.menuItemGapPx ?? 12));
  const transitionMs = Math.min(1200, Math.max(200, venue.breakTransitionMs ?? 600));
  const breakFontScale = Math.min(200, Math.max(50, venue.breakFontSizePercent ?? 100)) / 100;

  useEffect(() => {
    const interval = breakActive ? 1000 : 60_000;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [breakActive, venue.breakEndsAt]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const clock = clockRef.current;
    const panel = panelRef.current;
    const timer = timerRef.current;
    const morph = morphRef.current;
    if (!shell || !clock || !panel || !timer || !morph) return;

    const stateChanged = previousBreakActive.current !== null && previousBreakActive.current !== breakActive;
    previousBreakActive.current = breakActive;
    if (!stateChanged) {
      shell.classList.remove("morph-active");
      setMorphActive(false);
      morph.className = `break-morph ${breakExpired ? "is-expired" : ""}`;
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clockInline = { visibility: clock.style.visibility, opacity: clock.style.opacity, transform: clock.style.transform };
    const panelInline = { transition: panel.style.transition, transform: panel.style.transform, opacity: panel.style.opacity };
    clock.style.visibility = "visible";
    clock.style.opacity = "1";
    clock.style.transform = "none";
    panel.style.transition = "none";
    panel.style.transform = "none";
    panel.style.opacity = "1";
    const clockRect = clock.getBoundingClientRect();
    const timerRect = timer.getBoundingClientRect();
    if (!breakActive) lastClockRect.current = clockRect;
    const from = breakActive ? clockRect : timerRect;
    const to = breakActive ? timerRect : (lastClockRect.current ?? clockRect);
    clock.style.visibility = clockInline.visibility;
    clock.style.opacity = clockInline.opacity;
    clock.style.transform = clockInline.transform;
    panel.style.transition = panelInline.transition;
    panel.style.transform = panelInline.transform;
    panel.style.opacity = panelInline.opacity;

    if (reducedMotion || breakExpired || from.width <= 0 || to.width <= 0) {
      shell.classList.remove("morph-active");
      setMorphActive(false);
      morph.className = `break-morph ${breakExpired ? "is-expired" : ""}`;
      return;
    }
    shell.classList.add("morph-active");
    setMorphActive(true);
    morph.className = `break-morph is-visible ${breakActive ? "is-to-timer" : "is-to-clock"}`;
    morph.style.left = `${from.left}px`;
    morph.style.top = `${from.top}px`;
    morph.style.width = `${from.width}px`;
    morph.style.height = `${from.height}px`;
    morph.style.transition = "none";
    void morph.offsetWidth;
    requestAnimationFrame(() => {
      morph.style.transition = `left ${transitionMs}ms cubic-bezier(.2,.8,.2,1), top ${transitionMs}ms cubic-bezier(.2,.8,.2,1), width ${transitionMs}ms cubic-bezier(.2,.8,.2,1), height ${transitionMs}ms cubic-bezier(.2,.8,.2,1)`;
      morph.style.left = `${to.left}px`;
      morph.style.top = `${to.top}px`;
      morph.style.width = `${to.width}px`;
      morph.style.height = `${to.height}px`;
    });
    const timerId = window.setTimeout(() => {
      shell.classList.remove("morph-active");
      setMorphActive(false);
      morph.className = "break-morph";
      morph.style.transition = "none";
    }, transitionMs + 80);
    return () => {
      window.clearTimeout(timerId);
      shell.classList.remove("morph-active");
    };
  }, [breakActive, breakExpired, transitionMs]);

  useEffect(() => {
    const resize = () => setViewport(readViewport());
    addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => { removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); };
  }, []);

  const usableWidth = viewport.width * (breakActive ? (100 - panelWidth) / 100 : 1);
  const scale = useMemo(() => venue.displayScaleMode === "manual"
    ? Math.min(160, Math.max(50, venue.displayScalePercent ?? 100)) / 100
    : autoScaleForMenu(categories, items, usableWidth, viewport.height), [venue.displayScaleMode, venue.displayScalePercent, categories, items, usableWidth, viewport.height]);
  const layout = useMemo(() => layoutForViewport(usableWidth, viewport.height, viewport.height / scale), [usableWidth, viewport.height, scale]);
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

  return <main ref={shellRef} className={`display-shell ${breakActive ? "break-active" : ""} ${breakExpired ? "break-expired" : ""} ${morphActive ? "morph-active" : ""}`} lang="ru" style={style}>
    <section className={`display-menu logo-${logoPosition}`} style={{ zoom: scale }}>
      <header className="display-header"><h1 style={{ color: accentColor }}>{formatRussianText(venue.name)}</h1><div className="display-header-meta"><time ref={clockRef} className="display-clock" dateTime={new Date(now).toISOString()}>{formatLocalDateTime(now)}</time>{pages.length > 1 && <span className="page-indicator" aria-live="polite" aria-label={`Страница ${pageIndex + 1} из ${pages.length}`}>{pageIndex + 1} / {pages.length}</span>}</div></header>
      {logoUrl && venue.logoVisible !== false && <img className="logo" src={logoUrl} alt="Логотип точки" />}
      {!page ? <div className="empty">Меню пока не заполнено</div> : <section className="page page-transition" key={`${pageIndex}-${items.length}-${breakActive}`} style={{ gridTemplateColumns: `repeat(${page.columns.length}, minmax(0, 1fr))` }}>
        {page.columns.map((column, columnIndex) => <div className="column" key={columnIndex}>{column.map((entry, rowIndex) => entry.kind === "category" ?
          <h2 key={`${entry.categoryId}-${rowIndex}`} style={{ color: accentColor, borderBottomColor: accentColor }}>{formatRussianText(entry.name)}{entry.repeated && <span className="continued"> · продолжение</span>}</h2> :
          <div className={`menu-item menu-item-enter ${entry.item.isAvailable ? "" : "unavailable"}`} key={entry.item.id} style={{ "--row-delay": `${Math.min(rowIndex, 12) * 35}ms` } as React.CSSProperties}><span className="item-name">{formatRussianText(entry.item.name)}</span><span className="dots" /><span className="price">{money.format(entry.item.priceMinor / 100)}</span></div>)}</div>)}
      </section>}
      <footer>{!connected ? <span className="connection offline">{freshnessLabel(updatedAt ?? null)}</span> : <span />}</footer>
    </section>
    <aside ref={panelRef} className="break-panel" aria-hidden={!breakActive}><div className="break-state-label">{breakExpired ? "Перерыв завершён" : "Перерыв"}</div>{breakExpired ? <strong ref={timerRef} className="break-expired-text">{formatRussianText(venue.breakExpiredText ?? "Скоро буду")}</strong> : <strong ref={timerRef} className="break-timer" aria-hidden="true" style={{ fontSize: `${Math.max(38, Math.min(118 * breakFontScale, viewport.width * panelWidth / 100 * .22))}px` }}>{Math.floor(breakSeconds / 60)}:{String(breakSeconds % 60).padStart(2, "0")}</strong>}</aside>
    <span ref={morphRef} className={`break-morph ${breakExpired ? "is-expired" : ""}`} aria-hidden="true"><span className="break-morph-clock">{formatLocalDateTime(now)}</span><span className="break-morph-timer">{Math.floor(breakSeconds / 60)}:{String(breakSeconds % 60).padStart(2, "0")}</span></span>
    <div ref={measureRef} className="menu-measure" aria-hidden="true" style={{ width: columnWidth, fontSize: itemFontSize }}><h2 data-measure-key="category">Раздел</h2>{items.map((item) => <div className="menu-item" data-measure-key={`item-${item.id}`} key={item.id}><span className="item-name">{formatRussianText(item.name)}</span><span className="dots" /><span className="price">{money.format(item.priceMinor / 100)}</span></div>)}</div>
  </main>;
}
