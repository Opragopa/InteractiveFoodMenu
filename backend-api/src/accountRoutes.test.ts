import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { hash } from "@node-rs/argon2";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { createApp } from "./server.js";

const config = {
  port: 0, publicUrl: "https://api.example.test", displayBaseUrl: "https://menu.example.test",
  appwriteEndpoint: "https://appwrite.example.test/v1", appwriteSelfSigned: false,
  appwriteProjectId: "project", appwriteApiKey: "a".repeat(32), appwriteDatabaseId: "database", appwriteBucketId: "bucket",
  sessionSecret: "s".repeat(32), hubAccessKey: "h".repeat(32), corsOrigins: ["https://menu.example.test"],
} satisfies BackendConfig;

function fakeServices() {
  const data = new Map<string, Map<string, Record<string, unknown>>>();
  const bucket = (table: string) => { if (!data.has(table)) data.set(table, new Map()); return data.get(table)!; };
  bucket("venues").set("venue-1", { $id: "venue-1", code: "cafe-one", name: "One", active: true, staffVersion: 1, menuVersion: 1 });
  bucket("venues").set("venue-2", { $id: "venue-2", code: "cafe-two", name: "Two", active: true, staffVersion: 1, menuVersion: 1 });
  const tables = {
    async listRows({ tableId, queries = [] }: { tableId: string; queries?: string[] }) {
      let rows = [...bucket(tableId).values()];
      for (const query of queries) {
        const item = JSON.parse(query) as { method: string; attribute?: string; values?: unknown[] };
        if (item.method === "equal") rows = rows.filter(row => item.values?.includes(row[item.attribute!]));
        if (item.method === "limit") rows = rows.slice(0, Number(item.values?.[0]));
      }
      return { rows, total: rows.length };
    },
    async getRow({ tableId, rowId }: { tableId: string; rowId: string }) {
      const row = bucket(tableId).get(rowId);
      if (!row) throw new Error("not found");
      return row;
    },
    async createRow({ tableId, rowId, data: row }: { tableId: string; rowId: string; data: Record<string, unknown> }) {
      if (bucket(tableId).has(rowId)) throw new Error("conflict");
      const result = { $id: rowId, ...row };
      bucket(tableId).set(rowId, result);
      return result;
    },
    async updateRow({ tableId, rowId, data: changes }: { tableId: string; rowId: string; data: Record<string, unknown> }) {
      const row = bucket(tableId).get(rowId);
      if (!row) throw new Error("not found");
      const result = { ...row, ...changes };
      bucket(tableId).set(rowId, result);
      return result;
    },
    async deleteRow({ tableId, rowId }: { tableId: string; rowId: string }) {
      if (!bucket(tableId).delete(rowId)) throw new Error("not found");
      return {};
    },
  };
  return { services: { tables, storage: {} } as unknown as AppwriteServices, bucket };
}

test("personal hub and staff accounts use cookies, one-use invites and immediate revocation", async () => {
  const { services, bucket } = fakeServices();
  bucket("operators").set("operator-1", { $id: "operator-1", username: "owner", passwordHash: await hash("a-long-hub-password"), active: true, sessionVersion: 1 });
  const server = createServer(createApp(config, services));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const origin = "https://menu.example.test";
  const post = (path: string, body: object, cookie = "", withOrigin = true) => fetch(`${base}/api${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(withOrigin ? { origin } : {}) }, body: JSON.stringify(body),
  });
  try {
    const hub = await post("/hub/login/password", { username: "owner", password: "a-long-hub-password" });
    assert.equal(hub.status, 200);
    assert.match(hub.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Lax/);
    const hubCookie = (hub.headers.get("set-cookie") ?? "").split(";")[0];
    const blocked = await post("/hub/venues/venue-1/staff/invitations", {}, hubCookie, false);
    assert.equal(blocked.status, 403);
    const invite = await post("/hub/venues/venue-1/staff/invitations", {}, hubCookie);
    assert.equal(invite.status, 201);
    const invitation = ((await invite.json()) as { url: string }).url.split("#invite=")[1];
    assert.ok(invitation);
    assert.equal(bucket("staff_invites").size, 1);
    assert.ok(!JSON.stringify([...bucket("staff_invites").values()]).includes(invitation.split(".")[1]));
    const activated = await post("/auth/staff/activate", { invitation, username: "alice", password: "alice-strong-password" });
    assert.equal(activated.status, 200);
    const staffCookie = (activated.headers.get("set-cookie") ?? "").split(";")[0];
    const emergency = await post("/hub/login", { accessKey: config.hubAccessKey });
    assert.equal(emergency.status, 200);
    assert.match(emergency.headers.get("set-cookie") ?? "", /ifm_hub=.*HttpOnly/);
    assert.equal((await emergency.json() as { token?: string }).token, undefined);
    const logout = await post("/auth/logout", { role: "hub" });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") ?? "", /ifm_hub=; Path=\/api\/hub/);
    assert.doesNotMatch(logout.headers.get("set-cookie") ?? "", /ifm_staff=/);
    assert.equal((await post("/auth/staff/activate", { invitation, username: "alice", password: "alice-strong-password" })).status, 401);
    assert.equal((await fetch(`${base}/api/menu`, { headers: { cookie: staffCookie } })).status, 200);
    assert.equal((await post("/auth/staff/password", { venueCode: "cafe-two", username: "alice", password: "alice-strong-password" })).status, 401);
    const accountId = [...bucket("staff_accounts").keys()][0];
    const reset = await post(`/hub/venues/venue-1/staff/${accountId}/reset`, {}, hubCookie);
    assert.equal(reset.status, 201);
    assert.equal((await fetch(`${base}/api/menu`, { headers: { cookie: staffCookie } })).status, 401);
    const resetInvitation = ((await reset.json()) as { url: string }).url.split("#invite=")[1];
    assert.equal((await post("/auth/staff/activate", { invitation: resetInvitation, username: "bob", password: "new-strong-password" })).status, 400);
    assert.equal((await post("/auth/staff/activate", { invitation: resetInvitation, username: "alice", password: "new-strong-password" })).status, 200);
    const expiredInvite = await post("/hub/venues/venue-1/staff/invitations", {}, hubCookie);
    assert.equal(expiredInvite.status, 201);
    const expiredToken = ((await expiredInvite.json()) as { url: string }).url.split("#invite=")[1];
    const expiredId = expiredToken.split(".")[0];
    bucket("staff_invites").get(expiredId)!.expiresAt = "2020-01-01T00:00:00.000Z";
    assert.equal((await post("/auth/staff/activate", { invitation: expiredToken, username: "charlie", password: "charlie-strong-password" })).status, 401);
    assert.equal((await post(`/hub/venues/venue-1/staff/${accountId}/disable`, {}, hubCookie)).status, 200);
    assert.equal((await fetch(`${base}/api/menu`, { headers: { cookie: staffCookie } })).status, 401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
