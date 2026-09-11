import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDisplayBaseUrl } from "./displayUrl.js";

test("accepts a LAN display origin", () => {
  assert.equal(normalizeDisplayBaseUrl("http://192.168.0.183:5173/"), "http://192.168.0.183:5173");
});

test("rejects a loopback display origin", () => {
  assert.throws(() => normalizeDisplayBaseUrl("http://127.0.0.1:5173"), /127.0.0.1/);
});

test("rejects an address with a path", () => {
  assert.throws(() => normalizeDisplayBaseUrl("https://menu.example.com/pair"), /без пути/);
});
