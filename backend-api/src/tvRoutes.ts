import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import { ID, type Models } from "node-appwrite";
import { menuSnapshot } from "./menuSnapshot.js";
import { menuStream } from "./menuEvents.js";
import QRCode from "qrcode";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { hashSecret, opaqueToken, signSession, verifySecret, verifySession, type SessionClaims } from "./security.js";
import { renderLegacyDisplay } from "./legacyDisplay.js";
import { recordDisplayContact, recordStatisticsEvent } from "./statistics.js";

type Row = Models.Row & Record<string, unknown>;
const COOKIE = "ifm_tv_session";
const PAIR_COOKIE = "ifm_tv_pair";
const TOKEN_FORMAT = /^([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})$/;
const COOKIE_HEADER = "Path=/tv; HttpOnly; SameSite=Lax";
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]!));
const wrap = (handler: (request: Request, response: Response) => Promise<void>) => (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(next);

function cookie(request: Request, name: string) {
  const entry = (request.header("cookie") ?? "").split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : "";
}
function setCookie(response: Response, request: Request, name: string, value: string, age: number) {
  const secure = request.secure || request.header("x-forwarded-proto") === "https";
  response.append("Set-Cookie", `${name}=${value}; ${COOKIE_HEADER}; Max-Age=${age}${secure ? "; Secure" : ""}`);
}
function noCache(response: Response) { response.set("Cache-Control", "no-store, no-cache, must-revalidate").set("Referrer-Policy", "no-referrer"); }
function document(response: Response, html: string) { noCache(response); response.type("html").set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'").send(html); }
function page(title: string, body: string, script = "") {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>body{margin:0;padding:32px;background:#f7f4ee;color:#24211f;font:22px Arial,sans-serif;text-align:center}main{max-width:760px;margin:4vh auto}h1{font-size:42px;color:#9c3d24}p{line-height:1.4}#qr{width:360px;height:360px;max-width:80vw;max-height:80vw;margin:24px auto;background:white}.error{color:#a12f24}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

async function displaySession(request: Request, services: AppwriteServices, config: BackendConfig): Promise<{ claims: SessionClaims; token: Row; venue: Row } | null> {
  let claims: SessionClaims;
  try { claims = verifySession(cookie(request, COOKIE), config.sessionSecret); }
  catch { return null; }
  if (claims.role !== "display" || !claims.venueId || !claims.displayTokenId) return null;
  const [token, venue] = await Promise.all([
    services.tables.getRow<Row>({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: claims.displayTokenId }).catch(() => null),
    services.tables.getRow<Row>({ databaseId: config.appwriteDatabaseId, tableId: "venues", rowId: claims.venueId }).catch(() => null),
  ]);
  if (!token || !venue || token.active !== true || venue.active === false || token.venueId !== claims.venueId || claims.version !== Number(venue.displayVersion ?? 1)) return null;
  return { claims, token, venue };
}

async function activate(services: AppwriteServices, config: BackendConfig, response: Response, request: Request, tokenId: string, secret: string) {
  const token = await services.tables.getRow<Row>({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: tokenId }).catch(() => null);
  if (!token || token.active !== true || !(await verifySecret(secret, String(token.tokenHash ?? "")))) return false;
  const venue = await services.tables.getRow<Row>({ databaseId: config.appwriteDatabaseId, tableId: "venues", rowId: String(token.venueId) }).catch(() => null);
  if (!venue || venue.active === false) return false;
  setCookie(response, request, COOKIE, signSession({ role: "display", venueId: String(token.venueId), displayTokenId: tokenId, version: Number(venue.displayVersion ?? 1) }, config.sessionSecret, "30d"), 30 * 86400);
  try { await recordStatisticsEvent(services, config.appwriteDatabaseId, String(token.venueId), "display_connected", "display", tokenId); } catch { /* display works even if statistics is unavailable */ }
  return true;
}

function size(value: unknown, fallback: number, min: number, max: number) { const n = Number(value); return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fallback; }

export function createTvRouter(services: AppwriteServices, config: BackendConfig) {
  const router = Router();
  router.get("/activate", (_request, response) => {
    document(response, page("Подключение экрана", '<h1>Подключаем экран…</h1><p id="status">Проверяем ссылку.</p>', `(function(){var m=/^#([A-Za-z0-9_-]{12,40})\\.([A-Za-z0-9_-]{32,80})$/.exec(location.hash);if(!m){document.getElementById('status').innerHTML='Ссылка экрана неполная.';return;}if(window.history&&window.history.replaceState)window.history.replaceState(null,'',location.pathname+location.search);var x=new XMLHttpRequest();x.open('POST','/tv/session',true);x.setRequestHeader('Content-Type','application/json');x.onreadystatechange=function(){if(x.readyState!==4)return;if(x.status===200){location.replace('/tv/menu?w='+encodeURIComponent(window.innerWidth||document.documentElement.clientWidth||1920)+'&h='+encodeURIComponent(window.innerHeight||document.documentElement.clientHeight||1080));}else{document.getElementById('status').innerHTML='Ссылка недействительна или отозвана.';}};x.onerror=function(){document.getElementById('status').innerHTML='Нет связи с сервером.';};x.send(JSON.stringify({tokenId:m[1],secret:m[2]}));})();`));
  });

  router.post("/session", wrap(async (request, response) => {
    noCache(response);
    const tokenId = String(request.body?.tokenId ?? ""); const secret = String(request.body?.secret ?? "");
    if (!TOKEN_FORMAT.test(`${tokenId}.${secret}`) || !(await activate(services, config, response, request, tokenId, secret))) { response.status(401).json({ error: "unauthenticated" }); return; }
    response.json({ url: "/tv/menu" });
  }));

  router.get("/connect", wrap(async (request, response) => {
    if (await displaySession(request, services, config)) { response.redirect(302, "/tv/menu"); return; }
    const id = ID.unique(); const secret = opaqueToken();
    await services.tables.createRow({ databaseId: config.appwriteDatabaseId, tableId: "display_pairings", rowId: id,
      data: { tokenHash: await hashSecret(secret), status: "pending", expiresAt: new Date(Date.now() + 300_000).toISOString(), createdAt: new Date().toISOString() } });
    const pairingToken = `${id}.${secret}`;
    const qr = await QRCode.toString(`${config.displayBaseUrl}/pair#${pairingToken}`, { type: "svg", width: 360, margin: 2, errorCorrectionLevel: "M" });
    setCookie(response, request, PAIR_COOKIE, pairingToken, 300);
    document(response, page("Подключение телевизора", `<h1>Подключение телевизора</h1><p>Отсканируйте QR-код телефоном сотрудника и введите код точки и PIN.</p><div id="qr">${qr}</div><p id="status">Ожидаем подключения…</p>`, `(function(){function poll(){var x=new XMLHttpRequest();x.open('GET','/tv/connect/status',true);x.onreadystatechange=function(){if(x.readyState!==4)return;var d={};try{d=JSON.parse(x.responseText)}catch(e){}if(x.status===200&&d.status==='complete'){location.replace('/tv/menu?w='+(window.innerWidth||document.documentElement.clientWidth||1920)+'&h='+(window.innerHeight||document.documentElement.clientHeight||1080));}else if(d.status==='expired'){document.getElementById('status').innerHTML='Код истёк. Обновите страницу.';}else if(x.status!==200){document.getElementById('status').innerHTML='Связь прервана. Повторяем проверку…';setTimeout(poll,3000);}else{setTimeout(poll,3000)}};x.onerror=function(){setTimeout(poll,5000)};x.send(null)}setTimeout(poll,2000)})();`));
  }));

  router.get("/connect/status", wrap(async (request, response) => {
    noCache(response);
    const match = TOKEN_FORMAT.exec(cookie(request, PAIR_COOKIE));
    if (!match) { response.status(401).json({ status: "expired" }); return; }
    const pairing = await services.tables.getRow<Row>({ databaseId: config.appwriteDatabaseId, tableId: "display_pairings", rowId: match[1] }).catch(() => null);
    if (!pairing || !(await verifySecret(match[2], String(pairing.tokenHash ?? ""))) || Date.parse(String(pairing.expiresAt)) < Date.now()) { response.status(401).json({ status: "expired" }); return; }
    if (pairing.status !== "complete") { response.json({ status: "pending" }); return; }
    const display = TOKEN_FORMAT.exec(String(pairing.displayUrl ?? "").split("#")[1] ?? "");
    if (!display || !(await activate(services, config, response, request, display[1], display[2]))) { response.status(401).json({ status: "expired" }); return; }
    setCookie(response, request, PAIR_COOKIE, "", 0);
    response.json({ status: "complete" });
  }));

  router.get("/menu", wrap(async (request, response) => {
    const current = await displaySession(request, services, config);
    if (!current) { document(response.status(401), page("Экран отключён", '<h1>Экран отключён</h1><p>Откройте страницу подключения заново.</p>')); return; }
    const venueId = current.claims.venueId!;
    const width = size(request.query.w, 1920, 480, 7680); const height = size(request.query.h, 1080, 360, 4320);
    const { data: menu } = await menuSnapshot(services, config.appwriteDatabaseId, venueId);
    await services.tables.updateRow({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: current.token.$id, data: { lastSeenAt: new Date().toISOString() } });
    try { await recordDisplayContact(services, config.appwriteDatabaseId, venueId, current.token.$id); } catch { /* retain display */ }
    noCache(response);
    response.type("html").set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'")
      .send(renderLegacyDisplay(menu.venue, menu.categories as never, menu.items as never, width, height, "", Date.now(), "/tv/state"));
  }));

  router.get("/events", wrap(async (request, response) => {
    const current = await displaySession(request, services, config);
    if (!current) { response.status(401).end(); return; }
    if (!services.events) { response.status(503).end(); return; }
    menuStream(request, response, services.events, current.claims.venueId!, async () => {
      const latest = await displaySession(request, services, config);
      return latest ? { version: Number(latest.venue.menuVersion ?? 1), hash: (await menuSnapshot(services, config.appwriteDatabaseId, current.claims.venueId!)).etag, breakActive: latest.venue.breakActive === true, breakEndsAt: latest.venue.breakEndsAt ?? null } : { revoked: true };
    });
  }));

  router.get("/state", wrap(async (request, response) => {
    const current = await displaySession(request, services, config);
    if (!current) { noCache(response.status(401)); response.json({ error: "session_revoked" }); return; }
    await services.tables.updateRow({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: current.token.$id, data: { lastSeenAt: new Date().toISOString() } });
    try { await recordDisplayContact(services, config.appwriteDatabaseId, current.claims.venueId!, current.token.$id); } catch { /* retain display */ }
    noCache(response);
    response.json({ version: Number(current.venue.menuVersion ?? 1), breakActive: current.venue.breakActive === true, breakEndsAt: current.venue.breakEndsAt ?? null });
  }));
  return router;
}
