type DisplayVenue = Record<string, unknown>;
type DisplayCategory = { id: string; name: string; sortOrder?: number };
type DisplayItem = { id: string; categoryId: string; name: string; priceMinor: number; servingSize?: string | null; caloriesKcal?: number | null; sortOrder?: number; isAvailable?: boolean };

const esc = (value: unknown) => String(value ?? "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]!));
const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback;

function money(minor: number) {
  return (minor / 100).toFixed(minor % 100 ? 2 : 0).replace(".", ",") + " ₽";
}

function paginate(categories: DisplayCategory[], items: DisplayItem[], width: number, height: number, scale: number, font: number, gap: number, maxColumnScale: number) {
  const pad = Math.max(24, Math.min(72, width * 0.035)) * scale;
  const innerWidth = Math.max(1, width - pad * 2);
  const textSize = font * scale * maxColumnScale;
  const longestName = items.reduce((length, item) => Math.max(length, item.name.length), 0);
  const minColumnWidth = Math.max(580, textSize * 13 + 160, longestName * textSize * 0.54 / 2 + textSize * 4.5 + 32);
  const columnCount = width / height < 1.25 ? 1 : Math.max(1, Math.min(3, Math.floor((innerWidth + 32) / (minColumnWidth + 32))));
  const columnWidth = (innerWidth - (columnCount - 1) * 28) / columnCount;
  const availableHeight = Math.max(1, height - pad * 2 - Math.max(100, 64 * scale) - 36 - 40);
  const itemHeight = (item: DisplayItem) => {
    const priceWidth = money(Number(item.priceMinor) || 0).length * textSize * 0.58;
    const nameWidth = Math.max(1, columnWidth - priceWidth - 24);
    const lines = Math.max(1, Math.ceil(item.name.length * textSize * 0.54 / nameWidth));
    return lines * textSize * 1.2 + gap * scale * maxColumnScale;
  };
  const headingHeight = 52 * scale * maxColumnScale;
  const columns: Array<Array<{ kind: "category"; text: string } | { kind: "item"; item: DisplayItem }>> = [];
  let column: typeof columns[number] = [];
  let used = 0;
  const flush = () => { if (column.length) columns.push(column); column = []; used = 0; };
  categories.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).forEach(category => {
    const categoryItems = items.filter(item => item.categoryId === category.id).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    if (!categoryItems.length) return;
    const sectionHeight = headingHeight + categoryItems.reduce((total, item) => total + itemHeight(item), 0);
    if (column.length && sectionHeight <= availableHeight && used + sectionHeight > availableHeight) flush();
    if (column.length && used + headingHeight + itemHeight(categoryItems[0]) > availableHeight) flush();
    column.push({ kind: "category", text: category.name });
    used += headingHeight;
    categoryItems.forEach((item, index) => {
      const rowHeight = itemHeight(item);
      if (column.length > 1 && used + rowHeight > availableHeight) {
        flush();
        column.push({ kind: "category", text: `${category.name}${index ? " · продолжение" : ""}` });
        used += headingHeight;
      }
      column.push({ kind: "item", item });
      used += rowHeight;
    });
  });
  flush();
  const pages: typeof columns[] = [];
  for (let index = 0; index < columns.length; index += columnCount) pages.push(columns.slice(index, index + columnCount));
  return pages;
}

export function renderLegacyDisplay(venue: DisplayVenue, categories: DisplayCategory[], items: DisplayItem[], width: number, height: number, credentials: string, now = Date.now()) {
  const bg = color(venue.backgroundColor, "#56965B");
  const accent = color(venue.accentColor, "#FFFFFF");
  const channels = [1, 3, 5].map(index => parseInt(bg.slice(index, index + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const ink = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] > 0.45 ? "#201F1C" : "#FFFFFF";
  const font = Math.min(54, Math.max(22, Number(venue.menuItemFontSizePx) || 34));
  const gap = Math.min(28, Math.max(4, Number(venue.menuItemGapPx) || 12));
  const columnScales = [venue.columnScale1Percent, venue.columnScale2Percent, venue.columnScale3Percent].map(value => Math.min(1.6, Math.max(0.5, Number(value) || 100) / 100));
  const maxColumnScale = Math.max(...columnScales);
  const breakActive = venue.breakActive === true;
  const panelWidth = Math.min(50, Math.max(30, Number(venue.breakPanelWidthPercent) || 36));
  const usableWidth = breakActive ? width * (100 - panelWidth) / 100 : width;
  let scale = venue.displayScaleMode === "manual" ? Math.min(1.6, Math.max(0.5, Number(venue.displayScalePercent) || 100) / 100) * (breakActive ? usableWidth / width : 1) : 0.8;
  if (venue.displayScaleMode !== "manual") {
    for (let candidate = 1.2; candidate >= 0.8; candidate -= 0.05) {
      if (paginate(categories, items, usableWidth, height, candidate, font, gap, maxColumnScale).length <= 1) { scale = candidate; break; }
    }
    if (scale === 0.8 && paginate(categories, items, usableWidth, height, scale, font, gap, maxColumnScale).length > 2) {
      for (let candidate = 1.2; candidate >= 0.8; candidate -= 0.05) {
        if (paginate(categories, items, usableWidth, height, candidate, font, gap, maxColumnScale).length <= 2) { scale = candidate; break; }
      }
    }
  }
  const displayFont = Math.round(font * scale);
  const displayGap = gap * scale;
  const padPx = Math.round(Math.max(24, Math.min(72, usableWidth * 0.035)) * scale);
  const contentWidth = Math.max(1, usableWidth - padPx * 2);
  const clockFont = Math.round(Math.max(18, Math.min(30, width * 0.017)) * scale);
  const breakScale = Math.min(2, Math.max(0.5, Number(venue.breakFontSizePercent) || 100)) / 100;
  const breakFont = Math.max(38, Math.min(118 * breakScale, width * (Number(venue.breakPanelWidthPercent) || 36) / 100 * 0.34, height * 0.3));
  const pages = paginate(categories, items, usableWidth, height, scale, font, gap, maxColumnScale);
  const pageHtml = pages.map((page, pageIndex) => `<section class="page" data-page="${pageIndex}" style="display:${pageIndex ? "none" : "table"}"><div class="columns">${page.map((column, columnIndex) => {
    const columnScale = columnScales[columnIndex] ?? 1;
    return `<div class="column">${column.map(entry => entry.kind === "category"
      ? `<h2 style="font-size:${Math.round(32 * scale * columnScale)}px"><span>${esc(entry.text)}</span>${venue.showServingSize || venue.showCalories ? `<span class="labels">${venue.showServingSize ? "Выход " : ""}Цена${venue.showCalories ? " Ккал" : ""}</span>` : ""}</h2>`
      : `<div class="item${entry.item.isAvailable === false ? " unavailable" : ""}${venue.showServingSize || venue.showCalories ? " has-details" : ""}" style="font-size:${Math.round(displayFont * columnScale)}px"><span class="item-name">${esc(entry.item.name)}</span>${venue.showServingSize || venue.showCalories ? "" : '<span class="leader"></span>'}${venue.showServingSize ? `<span class="serving">${esc(entry.item.servingSize || "—")}</span>` : ""}<span class="price">${money(Number(entry.item.priceMinor) || 0)}</span>${venue.showCalories ? `<span class="calories">${esc(entry.item.caloriesKcal ?? "—")} ккал</span>` : ""}</div>`).join("")}</div>`;
  }).join("")}</div></section>`).join("");
  const breakEnd = venue.breakEndsAt ? new Date(String(venue.breakEndsAt)).getTime() : now;
  const breakSeconds = Math.max(0, Math.ceil((breakEnd - now) / 1000));
  const logoVisible = typeof venue.logoFileId === "string" && venue.logoVisible !== false;
  const logoScale = Math.min(2, Math.max(0.5, Number(venue.logoScalePercent) || 100)) / 100;
  const logoWidth = Math.round(Math.min(260, width * 0.18) * logoScale * scale);
  const logoHeight = Math.round(Math.min(160, width * 0.11) * logoScale * scale);
  const logoInset = Math.max(0, Math.min(20, Number(venue.logoInsetPercent) || 3));
  const logoPosition = String(venue.logoPosition || "top-right");
  const logoSide = logoPosition.indexOf("right") > -1 ? "right" : "left";
  const logoOffset = logoSide === "right" && breakActive ? panelWidth + logoInset * (100 - panelWidth) / 100 : logoInset;
  const logoStyle = `${logoPosition.indexOf("top") === 0 ? "top" : "bottom"}:${logoInset}%;${logoSide}:${logoOffset}%;`;
  const refresh = Math.max(5, Math.min(300, Number(venue.menuRefreshSeconds) || 15));
  const duration = Math.max(5, Math.min(30, Number(venue.pageDurationSeconds) || 10));
  const stateUrl = `/api/display/legacy/${esc(credentials)}?state=1`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(venue.name || "Меню")}</title><style>
  @font-face{font-family:Onest;src:url('/fonts/onest-regular.ttf') format('truetype');font-style:normal;font-weight:400}@font-face{font-family:Onest;src:url('/fonts/onest-semibold.ttf') format('truetype');font-style:normal;font-weight:600}@font-face{font-family:Onest;src:url('/fonts/onest-bold.ttf') format('truetype');font-style:normal;font-weight:700}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Onest,Arial,sans-serif;background:${bg};color:${ink}}*{box-sizing:border-box}.shell{position:relative;width:100%;height:100%;padding:${padPx}px}.logo{position:absolute;z-index:1;object-fit:contain;width:${logoWidth}px;height:${logoHeight}px;${logoStyle}}.head{height:8%;display:table;width:${contentWidth}px;table-layout:fixed}.title{display:table-cell;vertical-align:middle;color:${accent};font-size:${Math.round(64 * scale)}px;font-weight:bold}.clock{display:table-cell;vertical-align:middle;text-align:right;font-size:${clockFont}px;white-space:nowrap}.pages{height:88%;width:${contentWidth}px}.page{height:100%;width:100%;table-layout:fixed}.columns{display:table;width:100%;height:100%;table-layout:fixed}.column{display:table-cell;vertical-align:top;width:${100 / (pages[0]?.length || 1)}%;padding:0 ${displayGap}px;overflow:hidden}h2{font-size:calc(${Math.round(32 * scale)}px * var(--column-scale));color:${accent};margin:8px 0 6px;padding-bottom:6px;border-bottom:2px solid ${accent}}h2 .labels{float:right;font-size:.55em;white-space:nowrap}.item{display:flex;align-items:flex-end;width:100%;overflow:hidden;padding:${displayGap / 2}px 0;font-size:calc(${displayFont}px * var(--column-scale));line-height:1.18}.item-name{display:block;flex:0 1 auto;min-width:0;font-weight:600;word-wrap:break-word;overflow-wrap:anywhere;padding:${displayGap / 2}px 0}.leader{display:block;flex:1 1 12px;min-width:12px;border-bottom:2px dotted rgba(128,128,128,.6);padding:${displayGap / 2}px 0}.price{display:block;flex:0 0 auto;width:auto;text-align:right;font-weight:bold;white-space:nowrap;padding:${displayGap / 2}px 0}.serving,.calories{display:inline-block;font-size:.76em;opacity:.85;margin-right:12px}.has-details{display:block}.has-details .item-name{display:block;width:100%}.has-details .price{display:inline-block;float:right;margin-left:12px;width:auto}.has-details .serving,.has-details .calories{display:inline-block}.unavailable .item-name,.unavailable .price{text-decoration:line-through;opacity:.45}.foot{height:4%;width:${contentWidth}px;text-align:right;font-size:16px;opacity:.72}.break{position:absolute;z-index:2;top:0;bottom:0;left:100%;width:${panelWidth}%;padding:4% 2%;background:#f6eee5;color:#201f1c;text-align:center;transition:left .7s ease;display:none}.break.active{display:block;left:${100 - panelWidth}%}.break-label{font-size:${Math.max(20, Math.min(68, width * .04))}px;font-weight:bold}.break-time{position:absolute;top:42%;left:3%;width:94%;font-size:${breakFont}px;font-weight:bold;font-variant-numeric:tabular-nums}.break-expired{font-size:${Math.max(36, Math.min(80, width * .06))}px;margin-top:25%}</style></head><body><main class="shell">${logoVisible ? `<img class="logo" src="/api/venue-assets/${encodeURIComponent(String(venue.logoFileId))}" alt="">` : ""}<header class="head"><div class="title">${esc(venue.name || "Меню")}</div><div class="clock" id="clock"></div></header><div class="pages">${pageHtml || `<div style="text-align:center;font-size:36px">Меню пока не заполнено</div>`}</div><div class="foot" id="page-number"></div><aside class="break${breakActive ? " active" : ""}" id="break"><div class="break-label" id="break-label">Перерыв</div><div class="break-time" id="break-time"></div></aside></main><script>(function(){var pages=document.querySelectorAll('.page'),index=0,seconds=${breakSeconds},active=${breakActive ? "true" : "false"},version=${Number(venue.menuVersion) || 1},endAt=${JSON.stringify(venue.breakEndsAt ?? null)};function pad(v){return v<10?'0'+v:String(v)}function tick(){var d=new Date();document.getElementById('clock').innerHTML=pad(d.getDate())+'.'+pad(d.getMonth()+1)+'.'+d.getFullYear()+' '+pad(d.getHours())+':'+pad(d.getMinutes());if(active){var t=document.getElementById('break-time');if(seconds>0){t.innerHTML=Math.floor(seconds/60)+':'+pad(seconds%60);seconds--}else{document.getElementById('break-label').innerHTML='Перерыв завершён';t.className='break-time break-expired';t.innerHTML='${esc(venue.breakExpiredText || "Скоро буду")}';}}}function flip(){if(pages.length<2)return;pages[index].style.display='none';index=(index+1)%pages.length;pages[index].style.display='table';document.getElementById('page-number').innerHTML='Страница '+(index+1)+' из '+pages.length}function poll(){var xhr=new XMLHttpRequest();xhr.open('GET','${stateUrl}',true);xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;if(xhr.status===200){try{var state=JSON.parse(xhr.responseText);if(state.version!==version||state.breakActive!==active||state.breakEndsAt!==endAt)window.location.reload()}catch(ignore){}}else if(xhr.status===401||xhr.status===403){document.body.innerHTML='Экран отключён или переподключён.'}};xhr.send(null)}tick();setInterval(tick,1000);if(pages.length>1)setInterval(flip,${duration * 1000});setInterval(poll,${refresh * 1000})})();</script></body></html>`;
}
