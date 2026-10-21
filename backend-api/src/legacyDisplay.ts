import { menuEtag } from "./menuHash.js";
type DisplayVenue = Record<string, unknown>;
type DisplayCategory = { id: string; name: string; sortOrder?: number };
type DisplayItem = { id: string; categoryId: string; name: string; priceMinor: number; servingSize?: string | null; caloriesKcal?: number | null; sortOrder?: number; isAvailable?: boolean; stockQuantity?: number | null };

const esc = (value: unknown) => String(value ?? "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]!));
const scriptString = (value: unknown) => JSON.stringify(String(value ?? "")).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback;

function money(minor: number) {
  return (minor / 100).toFixed(minor % 100 ? 2 : 0).replace(".", ",") + " руб.";
}

function paginate(categories: DisplayCategory[], items: DisplayItem[], width: number, height: number, scale: number, font: number, gap: number, maxColumnScale: number, hasDetails: boolean, pageHeight?: number) {
  const pad = Math.max(24, Math.min(72, width * 0.035)) * scale;
  const innerWidth = Math.max(1, width - pad * 2);
  const textSize = font * scale * maxColumnScale;
  const longestName = items.reduce((length, item) => Math.max(length, textWidth(item.name, textSize)), 0);
  const longestServing = hasDetails ? items.reduce((length, item) => Math.max(length, textWidth(String(item.servingSize || "—"), textSize * .85)), 0) : 0;
  const longestCalories = hasDetails ? items.reduce((length, item) => Math.max(length, textWidth(String(item.caloriesKcal ?? "—"), textSize * .85)), 0) : 0;
  const detailWidth = hasDetails ? longestServing + longestCalories + textSize * 7 : 0;
  const minColumnWidth = Math.max(440, textSize * 12 + 140, longestName / 2 + textSize * 5, detailWidth);
  const columnCount = width / height < 1.25 ? 1 : Math.max(1, Math.min(3, Math.floor((innerWidth + 32) / (minColumnWidth + 32))));
  const columnWidth = (innerWidth - (columnCount - 1) * 28) / columnCount;
  const availableHeight = Math.max(1, Math.min(height - pad * 2 - Math.max(100, 64 * scale) - 36 - 40, (height - pad * 2) * .88 - 24, pageHeight ? pageHeight - 20 : Infinity));
  const itemHeight = (item: DisplayItem) => {
    const priceWidth = hasDetails ? 0 : textWidth(money(Number(item.priceMinor) || 0), textSize, "bold") + 30;
    // The browser's auto table layout reserves extra space for the leader and
    // price cell. Keep the server's line count conservative so the last row
    // cannot be clipped at the bottom of an old TV viewport.
    const nameWidth = Math.max(1, (columnWidth - priceWidth - 24) * .95);
    const lines = wrappedLineCount(item.name, nameWidth, textSize);
    return lines * textSize * 1.28 + (hasDetails ? textSize * 1.5 : 0) + gap * scale * maxColumnScale;
  };
  const headingHeight = Math.max(52 * scale * maxColumnScale, textSize * (hasDetails ? 2 : 1.2) + 25);
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

export function renderLegacyDisplay(venue: DisplayVenue, categories: DisplayCategory[], items: DisplayItem[], width: number, height: number, credentials: string, now = Date.now(), stateUrlOverride?: string) {
  const bg = color(venue.backgroundColor, "#56965B");
  const accent = color(venue.accentColor, "#FFFFFF");
  const channels = [1, 3, 5].map(index => parseInt(bg.slice(index, index + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const ink = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] > 0.45 ? "#201F1C" : "#FFFFFF";
  const resolutionScale = Math.max(1, height / 768);
  const font = Math.min(54, Math.max(22, Number(venue.menuItemFontSizePx) || 34)) * resolutionScale;
  const gap = Math.min(28, Math.max(4, Number(venue.menuItemGapPx) || 12));
  const columnScales = [venue.columnScale1Percent, venue.columnScale2Percent, venue.columnScale3Percent].map(value => Math.min(1.6, Math.max(0.5, Number(value) || 100) / 100));
  const maxColumnScale = Math.max(...columnScales);
  const breakActive = venue.breakActive === true;
  const panelWidth = Math.min(50, Math.max(30, Number(venue.breakPanelWidthPercent) || 36));
  const usableWidth = breakActive ? width * (100 - panelWidth) / 100 : width;
  const scale = venue.displayScaleMode === "manual"
    ? Math.min(1.6, Math.max(0.5, Number(venue.displayScalePercent) || 100) / 100) * (breakActive ? usableWidth / width : 1)
    : 1;
  const hasDetails = venue.showServingSize === true || venue.showCalories === true;
  const displayFont = Math.round(font * scale);
  const displayGap = gap * scale;
  const padPx = Math.round(Math.max(24, Math.min(72, usableWidth * 0.035)) * scale);
  const contentWidth = Math.max(1, usableWidth - padPx * 2);
  const clockFont = Math.round(Math.max(18, Math.min(30, width * 0.017)) * scale);
  const breakScale = Math.min(2, Math.max(0.5, (Number(venue.breakFontSizePercent) || 100) / 100));
  const breakFont = Math.max(38, Math.min(118 * breakScale, width * (Number(venue.breakPanelWidthPercent) || 36) / 100 * 0.34, height * 0.3));
  const logoVisible = venue.logoVisible !== false;
  const logoScale = Math.min(2, Math.max(0.5, (Number(venue.logoScalePercent) || 100) / 100));
  const logoWidth = Math.round(Math.min(260, width * 0.18) * logoScale * scale);
  const logoHeight = Math.round(Math.min(84, height * 0.10) * logoScale * scale);
  const logoInset = Math.max(0, Math.min(20, Number(venue.logoInsetPercent) || 3));
  const logoPosition = String(venue.logoPosition || "top-right");
  const logoSide = logoPosition.indexOf("right") > -1 ? "right" : "left";
  const logoOffset = logoSide === "right" && breakActive ? panelWidth + logoInset * (100 - panelWidth) / 100 : logoInset;
  const logoStyle = `${logoPosition.indexOf("top") === 0 ? "top" : "bottom"}:${logoInset}%;${logoSide}:${logoOffset}%;`;
  const headerWidth = Math.max(1, contentWidth - (logoVisible && logoPosition.indexOf("top") === 0 && logoSide === "right" ? logoWidth + 12 : 0));
  const titleFont = Math.round(Math.min(64 * resolutionScale * scale, Math.max(64, height * .06)));
  const titleWidth = Math.max(100, headerWidth - textWidth("00.00.0000 00:00", clockFont, "bold") - 18);
  const titleLines = wrappedLineCount(String(venue.name || "Меню"), titleWidth, titleFont);
  const headerHeight = Math.max(70, Math.ceil(titleLines * titleFont * 1.18));
  const footerHeight = 28;
  const pagesHeight = Math.max(100, height - padPx * 2 - headerHeight - footerHeight);
  const pages = paginate(categories, items, usableWidth, height, scale, font, gap, maxColumnScale, hasDetails, pagesHeight);
  const pageHtml = pages.map((page, pageIndex) => `<section class="page" data-page="${pageIndex}" style="display:${pageIndex ? "none" : "table"}"><div class="columns">${page.map((column, columnIndex) => {
    const columnScale = columnScales[columnIndex] ?? 1;
    return `<div class="column">${column.map(entry => entry.kind === "category"
      ? `<h2 style="font-size:${Math.round(32 * resolutionScale * scale * columnScale)}px"><span>${esc(entry.text)}</span>${hasDetails ? `<span class="labels">${venue.showServingSize ? `<span>Выход</span>` : ""}<span class="label-price">Цена</span>${venue.showCalories ? `<span class="label-calories">Ккал</span>` : ""}</span>` : ""}</h2>`
      : `<div class="item${(entry.item.stockQuantity == null ? entry.item.isAvailable === false : entry.item.stockQuantity === 0) ? " unavailable" : ""}${hasDetails ? " has-details" : ""}" style="font-size:${Math.round(displayFont * columnScale)}px"><div class="main-row"><span class="item-name">${esc(entry.item.name)}</span>${hasDetails ? "" : `<span class="leader"></span><span class="price">${money(Number(entry.item.priceMinor) || 0)}</span>`}</div>${hasDetails ? `<div class="details">${venue.showServingSize ? `<span class="serving">Выход: ${esc(entry.item.servingSize || "—")}</span>` : ""}<span class="price">${money(Number(entry.item.priceMinor) || 0)}</span>${venue.showCalories ? `<span class="calories">${esc(entry.item.caloriesKcal ?? "—")} ккал</span>` : ""}</div>` : ""}</div>`).join("")}</div>`;
  }).join("")}</div></section>`).join("");
  const breakEnd = venue.breakEndsAt ? new Date(String(venue.breakEndsAt)).getTime() : now;
  const breakSeconds = Math.max(0, Math.ceil((breakEnd - now) / 1000));
  const duration = Math.max(5, Math.min(30, Number(venue.pageDurationSeconds) || 10));
  const eventsUrl = stateUrlOverride ? "/tv/events" : `/api/display/legacy/${esc(credentials)}?events=1`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Меню — ${esc(venue.name || "InteractiveFoodMenu")}</title><style>
  @font-face{font-family:Onest;src:url('/fonts/onest-static-regular.ttf?v=2') format('truetype');font-style:normal;font-weight:400}@font-face{font-family:Onest;src:url('/fonts/onest-static-semibold.ttf?v=2') format('truetype');font-style:normal;font-weight:600}@font-face{font-family:Onest;src:url('/fonts/onest-static-bold.ttf?v=2') format('truetype');font-style:normal;font-weight:700}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Onest,Arial,sans-serif;background:${bg};color:${ink}}*{box-sizing:border-box}.shell{position:relative;width:100%;height:100%;padding:${padPx}px}.logo{position:absolute;z-index:1;object-fit:contain;width:${logoWidth}px;height:${logoHeight}px;${logoStyle}}.head{height:${headerHeight}px;display:table;width:${headerWidth}px;table-layout:fixed}.title{display:table-cell;vertical-align:middle;color:${accent};font-size:${titleFont}px;font-weight:bold}.clock{display:table-cell;vertical-align:middle;text-align:right;font-size:${clockFont}px;white-space:nowrap}.pages{height:${pagesHeight}px;width:${contentWidth}px}.page{height:100%;width:100%;table-layout:fixed}.columns{display:table;width:100%;height:100%;table-layout:fixed}.column{display:table-cell;vertical-align:top;width:${100 / (pages[0]?.length || 1)}%;padding:0 ${displayGap}px;overflow:hidden}h2{color:${accent};margin:8px 0 6px;padding-bottom:6px;border-bottom:2px solid ${accent}}h2 .labels{display:table;width:100%;margin-top:.2em;font-size:.7em;white-space:nowrap}h2 .labels span{display:table-cell}h2 .labels span:first-child{width:50%}h2 .label-price{width:25%;text-align:right}h2 .label-calories{width:25%;text-align:right}.item{display:block;width:100%;overflow:hidden;padding:${displayGap / 2}px 0;line-height:1.18}.main-row{display:table;width:100%;table-layout:auto}.item-name{display:table-cell;vertical-align:bottom;font-weight:600;word-wrap:break-word;overflow-wrap:break-word;word-break:break-word}.leader{display:table-cell;width:8%;border-bottom:2px dotted rgba(128,128,128,.6)}.price{display:table-cell;width:1%;text-align:right;font-weight:bold;white-space:nowrap;padding-left:12px}.details{display:table;width:100%;table-layout:auto;margin-top:.12em;font-size:.85em;line-height:1.25}.details .price{font-size:1.176em;text-align:right}.serving,.calories{display:table-cell;white-space:normal;word-wrap:break-word}.serving{width:50%}.calories{width:25%;text-align:right}.unavailable .item-name,.unavailable .price{text-decoration:line-through;opacity:.45}.foot{height:${footerHeight}px;width:${contentWidth}px;text-align:right;font-size:16px;opacity:.72}.offline{display:none;position:absolute;bottom:8px;left:12px;right:12px;padding:8px;text-align:center;background:#a12f24;color:white;font:18px Arial,sans-serif}.break{position:absolute;z-index:2;top:0;bottom:0;left:100%;width:${panelWidth}%;padding:4% 2%;background:#f6eee5;color:#201f1c;text-align:center;transition:left .7s ease;display:none}.break.active{display:block;left:${100 - panelWidth}%}.break-label{font-size:${Math.max(20, Math.min(68, width * .04))}px;font-weight:bold}.break-time{position:absolute;top:42%;left:3%;width:94%;font-size:${breakFont}px;font-weight:bold;font-variant-numeric:tabular-nums}.break-expired{font-size:${Math.max(36, Math.min(80, width * .06))}px;margin-top:25%}</style></head><body><main class="shell">${logoVisible ? `<img class="logo" src="${typeof venue.logoFileId === "string" && venue.logoFileId ? `/api/venue-assets/${encodeURIComponent(venue.logoFileId)}` : "/politech-logo-white.svg"}" alt="">` : ""}<header class="head"><div class="title">${esc(venue.name || "Меню")}</div><div class="clock" id="clock"></div></header><div class="pages">${pageHtml || `<div style="text-align:center;font-size:36px">Меню пока не заполнено</div>`}</div><div class="foot" id="page-number"></div><div class="offline" id="offline">Нет связи с сервером. Показываем последнее загруженное меню.</div><aside class="break${breakActive ? " active" : ""}" id="break"><div class="break-label" id="break-label">Перерыв</div><div class="break-time" id="break-time"></div></aside></main><script>(function(){var pages=document.querySelectorAll('.page'),index=0,seconds=${breakSeconds},active=${breakActive ? "true" : "false"},version=${Number(venue.menuVersion) || 1},hash=${scriptString(menuEtag({venue,categories,items}))},endAt=${JSON.stringify(venue.breakEndsAt ?? null)};function pad(v){return v<10?'0'+v:String(v)}function tick(){var d=new Date();document.getElementById('clock').innerHTML=pad(d.getDate())+'.'+pad(d.getMonth()+1)+'.'+d.getFullYear()+' '+pad(d.getHours())+':'+pad(d.getMinutes());if(active){var t=document.getElementById('break-time');if(seconds>0){t.innerHTML=Math.floor(seconds/60)+':'+pad(seconds%60);seconds--}else{document.getElementById('break-label').innerHTML='Перерыв завершён';t.className='break-time break-expired';t.innerHTML=${scriptString(venue.breakExpiredText || "Скоро буду")};}}}function flip(){if(pages.length<2)return;pages[index].style.display='none';index=(index+1)%pages.length;pages[index].style.display='table';document.getElementById('page-number').innerHTML='Страница '+(index+1)+' из '+pages.length}tick();if(pages.length>1)document.getElementById('page-number').innerHTML='Страница 1 из '+pages.length;var clockTimer=setInterval(tick,1000),pageTimer=null;if(pages.length>1)pageTimer=setInterval(flip,${duration * 1000});var retry=2000,stream=null,retryTimer=null,stopped=false,loadingMenu=false;function stopUpdates(){stopped=true;clearTimeout(retryTimer);clearInterval(clockTimer);clearInterval(pageTimer);if(stream)stream.abort()}function reloadMenu(){if(loadingMenu||stopped)return;loadingMenu=true;var update=new XMLHttpRequest();function failed(){loadingMenu=false;document.getElementById('offline').style.display='block';if(stream)stream.abort()}update.open('GET',window.location.href.split('#')[0],true);update.onreadystatechange=function(){if(update.readyState!==4)return;if(update.status===200&&update.responseText.indexOf('<!doctype html>')===0){stopUpdates();document.open();document.write(update.responseText);document.close()}else if(update.status===401||update.status===403){stopUpdates();document.body.innerHTML='Экран отключён или переподключён.'}else failed()};update.timeout=15000;update.onerror=failed;update.ontimeout=failed;update.send(null)}function apply(state){if(state.revoked){stopUpdates();document.body.innerHTML='Экран отключён или переподключён.';return}document.getElementById('offline').style.display='none';if((state.hash&&state.hash!==hash)||state.version!==version||state.breakActive!==active||state.breakEndsAt!==endAt)reloadMenu()}function connect(){if(stopped)return;var x=new XMLHttpRequest(),used=0,buffer='',failed=false;stream=x;function fail(){if(failed||stopped)return;failed=true;x.abort();document.getElementById('offline').style.display='block';retryTimer=setTimeout(connect,retry);retry=Math.min(60000,retry*2)}x.open('GET',${scriptString(eventsUrl)},true);x.onreadystatechange=function(){if(failed||stopped||x.readyState<3)return;if(x.status===401||x.status===403){failed=true;stopUpdates();document.body.innerHTML='Экран отключён или переподключён.';return}if(x.status!==200){if(x.readyState===4)fail();return}buffer+=x.responseText.substring(used);used=x.responseText.length;var end;while((end=buffer.indexOf('\\n\\n'))>=0){var frame=buffer.substring(0,end);buffer=buffer.substring(end+2);if(frame.indexOf('event: unavailable')>=0){fail();return}var match=/data: ([^\\n]+)/.exec(frame);if(match){try{apply(JSON.parse(match[1]));retry=2000}catch(e){fail();return}}}if(x.readyState===4)fail()};x.onerror=fail;x.send(null)}connect()})();</script></body></html>`;
}
import { textWidth, wrappedLineCount } from "./fontMetrics.js";
