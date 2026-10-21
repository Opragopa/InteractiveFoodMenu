import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AppwriteException } from "node-appwrite";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { createApp } from "./server.js";
import { hashSecret, signSession } from "./security.js";

type Row = Record<string, any>;
const config: BackendConfig = {
  port: 0, publicUrl: "https://api.example.test", displayBaseUrl: "https://menu.example.test",
  appwriteEndpoint: "https://appwrite.example.test/v1", appwriteSelfSigned: false,
  appwriteProjectId: "project", appwriteApiKey: "a".repeat(32), appwriteDatabaseId: "database", appwriteBucketId: "bucket",
  sessionSecret: "s".repeat(32), hubAccessKey: "h".repeat(32), corsOrigins: ["https://menu.example.test"],
};
const pinHash = hashSecret("123456");
const screenSecret = "q".repeat(43);
const screenHash = hashSecret(screenSecret);

async function fixture() {
  const data = new Map<string, Map<string, Row>>();
  const bucket = (tableId: string) => { if (!data.has(tableId)) data.set(tableId, new Map()); return data.get(tableId)!; };
  const put = (tableId: string, row: Row) => { bucket(tableId).set(row.$id, row); return row; };
  const place = put("venues", { $id: "venue-1", code: "cafe-one", name: "One", pinHash: await pinHash, active: true, staffVersion: 1, displayVersion: 1, menuVersion: 1 });
  put("venues", { ...place, $id: "venue-2", code: "cafe-two", name: "Two" });
  put("categories", { $id: "cat-1", venueId: place.$id, name: "Food", sortOrder: 0 });
  const item = put("items", { $id: "item-1", venueId: place.$id, categoryId: "cat-1", name: "Tea", priceMinor: 100, sortOrder: 0, isAvailable: false, stockQuantity: 0 });
  let failPairingUpdate = false;
  let failVenueRead = false;
  let failAccountRead = false;
  const copy = (row: Row | undefined) => { if (!row) throw new AppwriteException("not found", 404); return { ...row }; };
  const tables = {
    async getRow({ tableId, rowId }: Row) {
      if (tableId === "venues" && failVenueRead) { failVenueRead = false; throw new AppwriteException("injected upstream outage", 503); }
      if (["staff_accounts", "operators"].includes(tableId) && failAccountRead) { failAccountRead = false; throw new AppwriteException("injected upstream outage", 503); }
      const result = copy(bucket(tableId).get(rowId));
      if (tableId === "items") await new Promise(resolve => setTimeout(resolve, 5));
      return result;
    },
    async listRows({ tableId, queries = [] }: Row) {
      let rows = [...bucket(tableId).values()];
      const parsed = queries.map((query: string) => JSON.parse(query));
      for (const q of parsed) if (q.method === "equal") rows = rows.filter(row => q.values.includes(row[q.attribute]));
      const total = rows.length;
      for (const q of parsed) {
        if (q.method === "cursorAfter") rows = rows.slice(rows.findIndex(row => row.$id === q.values[0]) + 1);
        if (q.method === "limit") rows = rows.slice(0, q.values[0]);
      }
      return { rows: rows.map(row => ({ ...row })), total };
    },
    async createRow({ tableId, rowId, data: value }: Row) {
      if (bucket(tableId).has(rowId)) throw new AppwriteException("conflict", 409);
      return { ...put(tableId, { $id: rowId, ...value }) };
    },
    async updateRow({ tableId, rowId, data: changes }: Row) {
      if (tableId === "display_pairings" && failPairingUpdate) { failPairingUpdate = false; throw new Error("injected pairing write failure"); }
      const row = bucket(tableId).get(rowId); copy(row);
      Object.assign(row!, changes); return { ...row };
    },
    async deleteRow({ tableId, rowId }: Row) {
      if (!bucket(tableId).delete(rowId)) throw new AppwriteException("not found", 404);
      return {};
    },
    async incrementRowColumn({ tableId, rowId, value, max }: Row) {
      const row = bucket(tableId).get(rowId)!;
      if (Number(row.stockQuantity) + value > max) throw new AppwriteException("maximum", 400);
      row.stockQuantity += value; return { ...row };
    },
    async decrementRowColumn({ tableId, rowId, value, min }: Row) {
      const row = bucket(tableId).get(rowId)!;
      if (Number(row.stockQuantity) - value < min) throw new AppwriteException("minimum", 400);
      row.stockQuantity -= value; return { ...row };
    },
  };
  const server = createServer(createApp(config, { tables, storage: {}, client: {} } as unknown as AppwriteServices));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const token = (role: "staff" | "hub" | "display", extra: Row = {}) => signSession({ role, ...(role === "hub" ? {} : { venueId: place.$id, version: 1 }), ...extra }, config.sessionSecret);
  const request = async (path: string, method = "GET", body?: Row, auth = token("staff"), cookie = "") => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, { method,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(cookie ? { cookie, origin: config.displayBaseUrl } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: response.status === 204 ? {} : await response.json() as Row };
  };
  const pairing = async (id = "pairing1234567890") => {
    put("display_pairings", { $id: id, status: "pending", tokenHash: await screenHash, expiresAt: new Date(Date.now() + 60000).toISOString() });
    return { pairingToken: `${id}.${screenSecret}`, venueCode: "cafe-one", pin: "123456" };
  };
  return { bucket, put, place, item, request, token, pairing, failPairing: () => { failPairingUpdate = true; }, failVenueRead: () => { failVenueRead = true; }, failAccountRead: () => { failAccountRead = true; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test("revoked and disabled staff sessions cannot mutate any venue resource", async () => {
  const f = await fixture();
  try {
    const operations: Array<[string, string, Row]> = [["/venue", "PATCH", { name: "Changed" }], ["/venue/break/start", "POST", {}], ["/venue/break/stop", "POST", {}], ["/categories", "POST", { name: "New" }], ["/categories/cat-1", "PATCH", { name: "Changed" }], ["/categories/cat-1", "DELETE", {}], ["/items", "POST", { categoryId: "cat-1", name: "New", priceMinor: 100 }], ["/items/item-1", "PATCH", { name: "Changed" }], ["/items/item-1/stock/adjust", "POST", { delta: 1 }], ["/items/bulk-availability", "PATCH", { itemIds: ["item-1"], isAvailable: true }], ["/items/item-1", "DELETE", {}], ["/display/rotate", "POST", {}]];
    f.place.staffVersion = 2;
    for (const [path, method, body] of operations) assert.equal((await f.request(path, method, body)).status, 401, path);
    f.place.staffVersion = 1; f.place.active = false;
    assert.equal((await f.request("/items/item-1", "PATCH", { name: "Changed" })).status, 401);
    assert.equal(f.item.name, "Tea");
    assert.equal(f.bucket("statistics_events").size, 0);
    f.place.active = true;
    f.put("staff_accounts", { $id: "worker", venueId: "venue-1", active: true, sessionVersion: 1 });
    const cookie = `ifm_staff=${f.token("staff", { accountId: "worker", accountVersion: 1 })}`;
    f.place.staffVersion = 2;
    assert.equal((await f.request("/items/item-1", "PATCH", { name: "Changed" }, "", cookie)).status, 401);
  } finally { await f.close(); }
});

test("staff menu version is authorized without recording display contacts", async () => {
  const f = await fixture();
  try {
    const result = await f.request("/menu/version");
    assert.equal(result.status, 200); assert.equal(result.data.version, 1);
    assert.equal(f.bucket("statistics_events").size, 0);
    f.place.staffVersion = 2;
    assert.equal((await f.request("/menu/version")).status, 401);
  } finally { await f.close(); }
});

test("all revoke operations invalidate every page of existing screen links", async t => {
  for (const [path, role] of [["/hub/venues/venue-1/displays/revoke-all", "hub"], ["/hub/venues/venue-1/revoke", "hub"], ["/display/rotate", "staff"]] as const) for (const count of [101, 201, 501]) await t.test(`${path} (${count} links)`, async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < count; index++) f.put("display_tokens", { $id: `screen-${index}`, venueId: "venue-1", active: true, tokenHash: await screenHash });
      const result = await f.request(path, "POST", {}, f.token(role)); assert.ok(result.status < 300);
      assert.equal([...f.bucket("display_tokens").values()].filter(row => row.$id.startsWith("screen-") && row.active).length, 0);
      assert.equal((await f.request("/auth/display", "POST", { tokenId: `screen-${count - 1}`, secret: screenSecret }, "")).status, 401);
      if (path.endsWith("revoke-all")) assert.equal(result.data.revoked, count);
    } finally { await f.close(); }
  });
});

test("parallel pairing retries share one screen and one URL", async () => {
  const f = await fixture();
  try {
    const body = await f.pairing();
    const results = await Promise.all([f.request("/display/pairings/complete", "POST", body, ""), f.request("/display/pairings/complete", "POST", body, "")]);
    assert.deepEqual(results.map(result => result.status), [200, 200]);
    assert.equal(results[0].data.displayUrl, results[1].data.displayUrl);
    assert.equal(f.bucket("display_tokens").size, 1);
    assert.equal((await f.request("/display/pairings/complete", "POST", body, "")).data.displayUrl, results[0].data.displayUrl);
  } finally { await f.close(); }
});

test("one pairing cannot connect competing venues and recovers a failed completion", async t => {
  await t.test("different venues", async () => {
    const f = await fixture();
    try {
      const body = await f.pairing();
      const results = await Promise.all([f.request("/display/pairings/complete", "POST", body, ""), f.request("/display/pairings/complete", "POST", { ...body, venueCode: "cafe-two" }, "")]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      assert.equal(f.bucket("display_tokens").size, 1);
    } finally { await f.close(); }
  });
  await t.test("retry after token was created", async () => {
    const f = await fixture();
    try {
      const body = await f.pairing(); f.failPairing();
      assert.equal((await f.request("/display/pairings/complete", "POST", body, "")).status, 500);
      assert.equal(f.bucket("display_tokens").size, 1);
      assert.equal((await f.request("/display/pairings/complete", "POST", body, "")).status, 200);
      assert.equal(f.bucket("display_tokens").size, 1);
      [...f.bucket("display_tokens").values()][0].active = false;
      assert.equal((await f.request("/display/pairings/complete", "POST", body, "")).status, 409);
    } finally { await f.close(); }
  });
});

test("concurrent stock writes count actual availability transitions", async t => {
  for (const absolute of [false, true]) await t.test(absolute ? "adjust with absolute stock" : "two atomic increments", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([f.request("/items/item-1/stock/adjust", "POST", { delta: 1 }), absolute ? f.request("/items/item-1", "PATCH", { stockQuantity: 2 }) : f.request("/items/item-1/stock/adjust", "POST", { delta: 1 })]);
      assert.deepEqual(results.map(result => result.status), [200, 200]);
      assert.equal([...f.bucket("statistics_events").values()].filter(row => row.eventType === "availability_changed").length, 1);
      f.item.stockQuantity = 1;
      const decrements = await Promise.all([f.request("/items/item-1/stock/adjust", "POST", { delta: -1 }), f.request("/items/item-1/stock/adjust", "POST", { delta: -1 })]);
      assert.deepEqual(decrements.map(result => result.status).sort(), [200, 409]); assert.equal(f.item.stockQuantity, 0);
    } finally { await f.close(); }
  });
});

test("bulk availability and single writes share item serialization", async () => {
  const f = await fixture();
  try {
    delete f.item.stockQuantity;
    const results = await Promise.all([f.request("/items/bulk-availability", "PATCH", { itemIds: ["item-1"], isAvailable: true }), f.request("/items/item-1", "PATCH", { isAvailable: true })]);
    assert.deepEqual(results.map(result => result.status), [200, 200]);
    assert.equal([...f.bucket("statistics_events").values()].filter(row => row.eventType === "availability_changed").length, 1);
  } finally { await f.close(); }
});


test("failed and overlapping item operations release their locks", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/items/item-1", "PATCH", { stockQuantity: -1 })).status, 400);
    assert.equal((await f.request("/items/item-1/stock/adjust", "POST", { delta: 1 })).status, 200);
    delete f.item.stockQuantity;
    f.put("items", { ...f.item, $id: "item-2", isAvailable: false });
    const bulk = await Promise.all([
      f.request("/items/bulk-availability", "PATCH", { itemIds: ["item-1", "item-2"], isAvailable: true }),
      f.request("/items/bulk-availability", "PATCH", { itemIds: ["item-2", "item-1"], isAvailable: false }),
    ]);
    assert.deepEqual(bulk.map(result => result.status), [200, 200]);
    const deletes = await Promise.all([f.request("/items/item-1", "DELETE"), f.request("/items/item-1", "DELETE")]);
    assert.deepEqual(deletes.map(result => result.status).sort(), [204, 404]);
    assert.equal((await f.request("/items/item-2", "PATCH", { name: "Still usable" })).status, 200);
  } finally { await f.close(); }
});

test("a stale staff cookie does not block a fresh PIN login", async () => {
  const f = await fixture();
  try {
    f.place.staffVersion = 2;
    const result = await f.request("/auth/staff", "POST", { venueCode: "cafe-one", pin: "123456" }, "", `ifm_staff=${f.token("staff")}`);
    assert.equal(result.status, 200);
    assert.ok(result.data.token);
  } finally { await f.close(); }
});

test("valid display credentials ignore an unrelated revoked staff cookie", async () => {
  const f = await fixture();
  try {
    f.put("display_tokens", { $id: "screen1234567890", venueId: "venue-1", active: true, tokenHash: await screenHash });
    f.place.staffVersion = 2;
    const result = await f.request("/auth/display", "POST", { tokenId: "screen1234567890", secret: screenSecret }, "", `ifm_staff=${f.token("staff")}`);
    assert.equal(result.status, 200);
    assert.ok(result.data.token);
    assert.equal((await f.request("/items/item-1", "PATCH", { name: "Still blocked" }, "", `ifm_staff=${f.token("staff")}`)).status, 401);
  } finally { await f.close(); }
});

test("account rate limits share canonical login identities", async t => {
  for (const mode of ["pin", "staff-password", "hub-password"] as const) await t.test(mode, async () => {
    const f = await fixture();
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const spaces = " ".repeat(attempt);
        const venueCode = `${spaces}${attempt % 2 ? "CAFE-ONE" : "cafe-one"}${spaces}`;
        const username = `${spaces}${attempt % 2 ? "ALICE" : "alice"}${spaces}`;
        const path = mode === "pin" ? "/auth/staff" : mode === "staff-password" ? "/auth/staff/password" : "/hub/login/password";
        const body = mode === "pin" ? { venueCode, pin: "000000", username: `ignored-${attempt}` } : { venueCode, username, password: "incorrect-password" };
        statuses.push((await f.request(path, "POST", body, "")).status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    } finally { await f.close(); }
  });
});


test("a transient Appwrite venue read failure does not revoke a valid staff session", async () => {
  const f = await fixture();
  try {
    f.failVenueRead();
    assert.equal((await f.request("/menu/version")).status, 500);
    assert.equal((await f.request("/menu/version")).status, 200);
    f.bucket("venues").delete("venue-1");
    assert.equal((await f.request("/menu/version")).status, 401);
  } finally { await f.close(); }
});


test("personal account lookup distinguishes transient Appwrite failure from missing account", async () => {
  const f = await fixture();
  try {
    f.put("staff_accounts", { $id: "worker", venueId: "venue-1", active: true, sessionVersion: 1 });
    const auth = f.token("staff", { accountId: "worker", accountVersion: 1 });
    f.failAccountRead();
    assert.equal((await f.request("/menu/version", "GET", undefined, auth)).status, 500);
    assert.equal((await f.request("/menu/version", "GET", undefined, auth)).status, 200);
    f.bucket("staff_accounts").delete("worker");
    assert.equal((await f.request("/menu/version", "GET", undefined, auth)).status, 401);
  } finally { await f.close(); }
});
