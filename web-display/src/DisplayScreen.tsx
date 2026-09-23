import { useEffect, useMemo, useState } from "react";
import { autoScaleForMenu, itemNameScale, layoutForViewport, paginateMenu } from "./paginate";
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

export function DisplayScreen({ venue, categories, items, logoUrl, connected, updatedAt }: {
  venue: Venue;
  categories: Category[];
  items: MenuItem[];
  logoUrl: string;
  connected: boolean;
  updatedAt?: number | null;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const logoPosition = venue.logoPosition ?? "top-right";
  const logoInset = Math.min(20, Math.max(0, venue.logoInsetPercent ?? 3));
  const logoScale = Math.min(200, Math.max(50, venue.logoScalePercent ?? 100)) / 100;
  const backgroundColor = /^#[0-9a-f]{6}$/i.test(venue.backgroundColor) ? venue.backgroundColor : "#56965B";
  const accentColor = /^#[0-9a-f]{6}$/i.test(venue.accentColor) ? venue.accentColor : "#FFFFFF";
  const foregroundColor = contrastForeground(backgroundColor);
  const breakFontScale = Math.min(200, Math.max(50, venue.breakFontSizePercent ?? 100)) / 100;
  const [viewport, setViewport] = useState(readViewport);
  const [now, setNow] = useState(Date.now());
  const breakSeconds = remainingBreakSeconds(venue.breakActive, venue.breakEndsAt, now);
  useEffect(() => {
    if (!venue.breakActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [venue.breakActive, venue.breakEndsAt]);
  useEffect(() => {
    const resize = () => setViewport(readViewport());
    addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => { removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); };
  }, []);
  const scale = useMemo(() => venue.displayScaleMode === "manual"
    ? Math.min(160, Math.max(50, venue.displayScalePercent ?? 100)) / 100
    : autoScaleForMenu(categories, items, viewport.width, viewport.height), [venue.displayScaleMode, venue.displayScalePercent, categories, items, viewport]);
  const pages = useMemo(() => {
    const layout = layoutForViewport(viewport.width / scale, viewport.height / scale);
    return paginateMenu(categories, items, layout.rowsPerColumn, layout.columnCount);
  }, [categories, items, viewport, scale]);
  useEffect(() => {
    setPageIndex((current) => pages.length ? Math.min(current, pages.length - 1) : 0);
    if (pages.length <= 1) return;
    const timer = window.setInterval(() => setPageIndex((current) => (current + 1) % pages.length), venue.pageDurationSeconds * 1000);
    return () => clearInterval(timer);
  }, [pages.length, venue.pageDurationSeconds]);

  const page = pages[pageIndex];
  if (breakSeconds > 0) return <main className="display break-screen" style={{ backgroundColor, color: foregroundColor }}><h1 className="break-title" style={{ color: accentColor }}>Перерыв</h1><strong className="break-timer" style={{ fontSize: `${15 * breakFontScale}vw` }}>{Math.floor(breakSeconds / 60)}:{String(breakSeconds % 60).padStart(2, "0")}</strong></main>;
  return (
    <main className={`display logo-${logoPosition}`} lang="ru" style={{
      zoom: scale,
      backgroundColor,
      color: foregroundColor,
      "--background": backgroundColor,
      "--accent": accentColor,
      "--foreground": foregroundColor,
      "--logo-inset": `${logoInset}%`,
      "--logo-scale": logoScale,
    } as React.CSSProperties}>
      <header><h1 style={{ color: accentColor }}>{formatRussianText(venue.name)}</h1></header>
      {logoUrl && venue.logoVisible !== false && <img className="logo" src={logoUrl} alt="Логотип точки" />}
      {!page ? <div className="empty">Меню пока не заполнено</div> : (
        <section className="page page-transition" key={`${pageIndex}-${items.filter((item) => item.isAvailable).length}`} style={{ gridTemplateColumns: `repeat(${page.columns.length}, minmax(0, 1fr))` }}>
          {page.columns.map((column, columnIndex) => (
            <div className="column" key={columnIndex}>
              {column.map((entry, rowIndex) => entry.kind === "category" ? (
                <h2 key={`${entry.categoryId}-${rowIndex}`} style={{ color: accentColor, borderBottomColor: accentColor }}>{formatRussianText(entry.name)}{entry.repeated && <span className="continued"> · продолжение</span>}</h2>
              ) : (
                <div className={`menu-item menu-item-enter ${entry.item.isAvailable ? "" : "unavailable"}`} key={entry.item.id} style={{ "--row-delay": `${Math.min(rowIndex, 12) * 35}ms` } as React.CSSProperties}>
                  <span className="item-name" style={{ fontSize: `${itemNameScale(entry.item.name)}em` }}>{formatRussianText(entry.item.name)}</span><span className="dots" /><span className="price">{money.format(entry.item.priceMinor / 100)}</span>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      <footer>
        {!connected && <span className="connection offline">{freshnessLabel(updatedAt ?? null)}</span>}
        {pages.length > 1 && <span>{pageIndex + 1} / {pages.length}</span>}
      </footer>
    </main>
  );
}
