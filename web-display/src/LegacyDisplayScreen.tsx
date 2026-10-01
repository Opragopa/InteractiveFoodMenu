import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayScreenProps } from "./DisplayScreen";
import { contrastForeground } from "./DisplayScreen";
import type { MenuItem } from "./types";
import { layoutForViewport, minMenuColumnWidth, paginateMenuByHeight } from "./paginate";
import { formatRussianText } from "./typography";
import { remainingBreakSeconds } from "./break";

const bounded = (value: number | undefined, fallback: number, min: number, max: number) => Math.min(max, Math.max(min, value ?? fallback));
const viewportSize = () => ({ width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight });
const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Chromium 38: literal lengths, static fonts, flex and ordinary block layout. */
export function LegacyDisplayScreen({ venue, categories, items, logoUrl, connected, updatedAt }: DisplayScreenProps) {
  const [viewport, setViewport] = useState(viewportSize);
  const [now, setNow] = useState(Date.now());
  const [pageIndex, setPageIndex] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [fontRevision, setFontRevision] = useState(0);
  const measureRef = useRef<HTMLDivElement>(null);
  const active = venue.breakActive === true;
  const panelWidth = bounded(venue.breakPanelWidthPercent, 36, 30, 50);
  const scale = bounded(venue.displayScalePercent, 100, 50, 160) / 100 * (active ? (100 - panelWidth) / 100 : 1);
  const width = viewport.width * (active ? (100 - panelWidth) / 100 : 1) / scale;
  const height = viewport.height / scale;
  const inset = width < 1400 ? 28 : 40;
  const contentWidth = width - inset * 2;
  const gutter = 28;
  const columnScales = [venue.columnScale1Percent, venue.columnScale2Percent, venue.columnScale3Percent].map(value => bounded(value, 100, 50, 160) / 100);
  const fontSize = bounded(venue.menuItemFontSizePx, 34, 22, 54);
  const columnCount = layoutForViewport(contentWidth, height, height, minMenuColumnWidth(fontSize * Math.max(...columnScales), items)).columnCount;
  const columnWidth = (contentWidth - (columnCount - 1) * gutter) / columnCount;
  const maxColumnScale = Math.max(...columnScales.slice(0, columnCount));
  const itemGap = bounded(venue.menuItemGapPx, 12, 4, 28);
  const background = /^#[0-9a-f]{6}$/i.test(venue.backgroundColor) ? venue.backgroundColor : "#56965B";
  const accent = /^#[0-9a-f]{6}$/i.test(venue.accentColor) ? venue.accentColor : "#FFFFFF";
  const showLogo = Boolean(logoUrl && venue.logoVisible !== false);
  const logoPosition = venue.logoPosition ?? "top-right";
  const logoHeight = showLogo ? 72 * bounded(venue.logoScalePercent, 100, 50, 200) / 100 : 0;
  const logoWidth = logoHeight * 1.7;
  const logoInset = Math.min(width, height) * bounded(venue.logoInsetPercent, 3, 0, 20) / 100;
  const logoTop = logoPosition.indexOf("top") === 0;
  const logoLeft = logoPosition.indexOf("left") > -1;
  // Reserve the actual logo footprint, including the configured inset.
  const headerHeight = Math.max(100, showLogo && logoTop ? logoInset + logoHeight - inset + 20 : 0);
  const footerHeight = Math.max(32, showLogo && !logoTop ? logoInset + logoHeight - inset + 12 : 0);
  const availableHeight = Math.max(1, height - inset * 2 - headerHeight - footerHeight);
  const seconds = remainingBreakSeconds(active, venue.breakEndsAt, now);
  const transition = bounded(venue.breakTransitionMs, 600, 200, 1200);

  useEffect(() => {
    const resize = () => setViewport(viewportSize());
    window.addEventListener("resize", resize);
    let timer = 0;
    const tick = () => {
      setNow(Date.now());
      const interval = active ? 1000 : 60_000;
      timer = window.setTimeout(tick, interval - Date.now() % interval + 12);
    };
    tick();
    return () => { window.removeEventListener("resize", resize); window.clearTimeout(timer); };
  }, [active]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { if (!cancelled) setFontRevision(value => value + 1); };
    // Font Loading API exists on Chromium 38; delayed measurement also covers
    // TV forks without it. A late font must not invalidate pagination.
    if (document.fonts?.ready) void document.fonts.ready.then(refresh);
    const timer = window.setTimeout(refresh, 2500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    const nodes = measureRef.current?.querySelectorAll<HTMLElement>("[data-measure-key]");
    if (!nodes) return;
    // NodeList.forEach is absent in Chromium 38.
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      next[node.getAttribute("data-measure-key")!] = Math.ceil(node.getBoundingClientRect().height);
    }
    setHeights(next);
  }, [items, categories, columnWidth, maxColumnScale, fontSize, itemGap, venue.showServingSize, venue.showCalories, fontRevision]);
  const pages = useMemo(() => paginateMenuByHeight(categories, items, availableHeight, columnCount, {
    category: Math.max(60, ...categories.map(category => heights[`category-${category.id}`] || 60)),
    item: item => heights[`item-${item.id}`] || (fontSize * 2.5 + itemGap * 2) * maxColumnScale,
  }), [categories, items, availableHeight, columnCount, heights, fontSize, itemGap, maxColumnScale]);
  useEffect(() => {
    setPageIndex(0);
    if (pages.length < 2) return;
    const timer = window.setInterval(() => setPageIndex(index => (index + 1) % pages.length), bounded(venue.pageDurationSeconds, 10, 5, 30) * 1000);
    return () => window.clearInterval(timer);
  }, [pages.length, venue.pageDurationSeconds]);

  const heading = (name: string, repeated: boolean, columnScale: number, key?: string) => <h2 className="tv-heading" data-measure-key={key} style={{ color: accent, borderBottomColor: accent, fontSize: 30 * columnScale }}>{formatRussianText(name)}{repeated && <span className="tv-continued"> · продолжение</span>}</h2>;
  const row = (item: MenuItem, columnScale: number, measure = false) => <div key={item.id} data-measure-key={measure ? `item-${item.id}` : undefined} className={`tv-row${item.isAvailable ? "" : " unavailable"}`} style={{ fontSize: fontSize * columnScale, paddingTop: itemGap * columnScale / 2, paddingBottom: itemGap * columnScale / 2 }}>
    <div className="tv-row-main"><span className="item-name">{formatRussianText(item.name)}</span><span className="tv-dots" /><span className="price">{money.format(item.priceMinor / 100)} ₽</span></div>
    {(venue.showServingSize || venue.showCalories) && <div className="tv-row-details">{venue.showServingSize && <span>Выход: {item.servingSize || "—"}</span>}{venue.showCalories && <span>{item.caloriesKcal ?? "—"} ккал</span>}</div>}
  </div>;
  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  const logoStyle = { width: logoWidth, height: logoHeight, top: logoTop ? logoInset : undefined, bottom: logoTop ? undefined : logoInset, left: logoLeft ? logoInset : undefined, right: logoLeft ? undefined : logoInset };
  return <main className="tv-screen" lang="ru" style={{ backgroundColor: background, color: contrastForeground(background) }}>
    <section className="tv-menu" style={{ width, height, padding: inset, zoom: scale, opacity: active ? (100 - bounded(venue.breakMenuDimPercent, 45, 25, 75)) / 100 : 1, transition: `opacity ${transition}ms ease` }}>
      <header className="tv-header" style={{ height: headerHeight, paddingLeft: showLogo && logoTop && logoLeft ? logoWidth + logoInset : 0, paddingRight: showLogo && logoTop && !logoLeft ? logoWidth + logoInset : 0 }}>
        <h1 style={{ color: accent }}>{formatRussianText(venue.name)}</h1>
        <div className="tv-meta"><time style={{ opacity: active ? 0 : 1 }}>{new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(now)}</time>{pages.length > 1 && <span>{pageIndex + 1} / {pages.length}</span>}</div>
      </header>
      {showLogo && <img className="tv-logo" style={logoStyle} src={logoUrl} alt="Логотип точки" />}
      <section className="tv-page" style={{ height: availableHeight }}>
        {page ? page.columns.map((column, index) => <div className="tv-column" key={index} style={{ width: columnWidth, marginRight: index < columnCount - 1 ? gutter : 0 }}>{column.map((entry, rowIndex) => entry.kind === "category" ? <div key={`heading-${rowIndex}`}>{heading(entry.name, entry.repeated, columnScales[index])}</div> : row(entry.item, columnScales[index]))}</div>) : <p className="tv-empty">Меню пока не заполнено</p>}
      </section>
      <footer className="tv-footer" style={{ height: footerHeight }}>{!connected && <span>Нет связи · {updatedAt ? `меню актуально на ${new Date(updatedAt).toLocaleString("ru-RU")}` : "показано последнее меню"}</span>}</footer>
    </section>
    <aside className="tv-break" aria-hidden={!active} aria-live="polite" style={{ width: `${panelWidth}%`, transform: active ? "translateX(-100%)" : "translateX(0)", transition: `transform ${transition}ms ease` }}>
      <div className="tv-break-label">{seconds ? "Перерыв" : "Перерыв завершён"}</div>
      <strong className="tv-break-value" style={{ fontSize: Math.min((seconds ? 118 : 72) * bounded(venue.breakFontSizePercent, 100, 50, 200) / 100, viewport.width * panelWidth / 100 * (seconds ? .28 : .14)) }}>{seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : formatRussianText(venue.breakExpiredText || "Скоро буду")}</strong>
    </aside>
    <div ref={measureRef} className="tv-measure" aria-hidden="true" style={{ width: columnWidth }}>{categories.map(category => <div key={category.id}>{heading(category.name, true, maxColumnScale, `category-${category.id}`)}</div>)}{items.map(item => row(item, maxColumnScale, true))}</div>
  </main>;
}
