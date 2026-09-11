import { useEffect, useMemo, useState } from "react";
import { layoutForViewport, paginateMenu } from "./paginate";
import type { Category, MenuItem, Venue } from "./types";
import { formatRussianText } from "./typography";

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 });

export function contrastForeground(hex: string) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return luminance > .45 ? "#201F1C" : "#FFFFFF";
}

export function DisplayScreen({ venue, categories, items, logoUrl, connected }: {
  venue: Venue;
  categories: Category[];
  items: MenuItem[];
  logoUrl: string;
  connected: boolean;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [viewport, setViewport] = useState(() => ({ width: innerWidth, height: innerHeight }));
  useEffect(() => {
    const resize = () => setViewport({ width: innerWidth, height: innerHeight });
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  const pages = useMemo(() => {
    const layout = layoutForViewport(viewport.width, viewport.height);
    return paginateMenu(categories, items.filter((item) => item.isAvailable), layout.rowsPerColumn, layout.columnCount);
  }, [categories, items, viewport]);
  useEffect(() => {
    setPageIndex((current) => pages.length ? Math.min(current, pages.length - 1) : 0);
    if (pages.length <= 1) return;
    const timer = window.setInterval(() => setPageIndex((current) => (current + 1) % pages.length), venue.pageDurationSeconds * 1000);
    return () => clearInterval(timer);
  }, [pages.length, venue.pageDurationSeconds]);

  const page = pages[pageIndex];
  return (
    <main className="display" lang="ru" style={{
      "--background": venue.backgroundColor,
      "--accent": venue.accentColor,
      "--foreground": contrastForeground(venue.backgroundColor),
    } as React.CSSProperties}>
      <header>{logoUrl && <img className="logo" src={logoUrl} alt="" />}<h1>{formatRussianText(venue.name)}</h1></header>
      {!page ? <div className="empty">Меню пока не заполнено</div> : (
        <section className="page page-transition" key={`${pageIndex}-${items.filter((item) => item.isAvailable).length}`} style={{ gridTemplateColumns: `repeat(${page.columns.length}, minmax(0, 1fr))` }}>
          {page.columns.map((column, columnIndex) => (
            <div className="column" key={columnIndex}>
              {column.map((entry, rowIndex) => entry.kind === "category" ? (
                <h2 key={`${entry.categoryId}-${rowIndex}`}>{formatRussianText(entry.name)}{entry.repeated && <span className="continued"> · продолжение</span>}</h2>
              ) : (
                <div className={`menu-item menu-item-enter ${entry.item.isAvailable ? "" : "unavailable"}`} key={entry.item.id} style={{ "--row-delay": `${Math.min(rowIndex, 12) * 35}ms` } as React.CSSProperties}>
                  <span className="item-name">{formatRussianText(entry.item.name)}</span><span className="dots" /><span className="price">{money.format(entry.item.priceMinor / 100)}</span>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      <footer>
        <span className={`connection ${connected ? "online" : "offline"}`}>{connected ? "Актуально" : "Нет связи · показано последнее меню"}</span>
        {pages.length > 1 && <span>{pageIndex + 1} / {pages.length}</span>}
      </footer>
    </main>
  );
}
