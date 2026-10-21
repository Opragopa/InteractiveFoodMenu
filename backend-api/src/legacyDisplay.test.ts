import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderLegacyDisplay } from "./legacyDisplay.js";

test("legacy menu moves enlarged rows to new pages without dropping items", () => {
  const categories = [{ id: "main", name: "Горячие блюда", sortOrder: 0 }];
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `item-${index}`, categoryId: "main", name: `Длинное название блюда с гарниром номер ${index}`,
    priceMinor: 25000 + index * 100, sortOrder: index,
  }));
  const venue = { name: "Кафе", backgroundColor: "#56965B", accentColor: "#FFFFFF", displayScaleMode: "manual", menuItemFontSizePx: 34 };
  const normal = renderLegacyDisplay({ ...venue, displayScalePercent: 100 }, categories, items, 1366, 768, "test");
  const enlarged = renderLegacyDisplay({ ...venue, displayScalePercent: 160 }, categories, items, 1366, 768, "test");
  assert.match(normal, /<title>Меню — Кафе<\/title>/);
  assert.match(normal, /руб\./);
  assert.doesNotMatch(normal, /₽/);
  assert.match(normal, /onest-static-regular\.ttf\?v=2/);
  assert.match(normal, /onest-static-semibold\.ttf\?v=2/);
  assert.match(normal, /onest-static-bold\.ttf\?v=2/);
  assert.doesNotMatch(normal, /onest-variable/);
  const pages = (html: string) => (html.match(/data-page="\d+"/g) ?? []).length;

  assert.ok(pages(enlarged) > pages(normal));
  assert.equal((enlarged.match(/class="item"/g) ?? []).length, items.length);
  assert.match(enlarged, /\.main-row\{display:table/);
  assert.doesNotMatch(enlarged, /var\(--column-scale\)/);
});

test("server-rendered menu reflows into the space beside the break panel", () => {
  const categories = [{ id: "main", name: "Горячие блюда" }];
  const items = Array.from({ length: 10 }, (_, index) => ({ id: `item-${index}`, categoryId: "main", name: `Блюдо с длинным названием ${index}`, priceMinor: 25000 }));
  const venue = { name: "Кафе", displayScaleMode: "manual", displayScalePercent: 100, breakPanelWidthPercent: 40 };
  const normal = renderLegacyDisplay(venue, categories, items, 1366, 768, "test");
  const active = renderLegacyDisplay({ ...venue, breakActive: true }, categories, items, 1366, 768, "test");
  const contentWidth = (html: string) => Number(html.match(/\.pages\{height:[\d.]+px;width:([\d.]+)px\}/)?.[1]);
  assert.ok(contentWidth(active) < contentWidth(normal) * .65);
  assert.match(active, /\.break\.active\{display:block;left:60%\}/);
  assert.doesNotMatch(active, /var\(--column-scale\)/);
  assert.equal((active.match(/class="item"/g) ?? []).length, items.length);
});

test("server-rendered legacy menu uses stock status without revealing quantity", () => {
  const html = renderLegacyDisplay(
    { name: "Кафе" },
    [{ id: "main", name: "Обед" }],
    [{ id: "soup", categoryId: "main", name: "Суп", priceMinor: 15000, isAvailable: true, stockQuantity: 0 }],
    1366, 768, "test",
  );
  assert.match(html, /class="item unavailable"/);
  assert.doesNotMatch(html, /0 шт\./);
});

test("server menu keeps full-size prices and gives nutrition rows enough pages", () => {
  const categories = [{ id: "main", name: "Обед" }];
  const items = Array.from({ length: 16 }, (_, index) => ({ id: `item-${index}`, categoryId: "main", name: index ? `Блюдо ${index}` : "Филе цыплёнка с картофельным пюре и сливочным соусом", priceMinor: index ? 25000 : 123456789, servingSize: index ? "250 г" : "1/150/030", caloriesKcal: index ? 250 : 12345 }));
  const venue = { displayScaleMode: "auto", menuItemFontSizePx: 34 };
  const plain = renderLegacyDisplay(venue, categories, items, 1366, 768, "test");
  const detailed = renderLegacyDisplay({ ...venue, showServingSize: true, showCalories: true }, categories, items, 1366, 768, "test");
  const pages = (html: string) => (html.match(/data-page="\d+"/g) ?? []).length;
  assert.ok(pages(detailed) >= pages(plain));
  assert.equal((detailed.match(/class="item has-details"/g) ?? []).length, items.length);
  assert.match(detailed, /font-size:34px"><div class="main-row">/);
  assert.match(detailed, /Выход: 1\/150\/030/);
  const ultraHd = renderLegacyDisplay({ ...venue, showCalories: true }, categories, items, 3840, 2160, "test");
  assert.match(ultraHd, /font-size:96px"><div class="main-row">/);
});

test("1920 menu reserves room for long prices and completed breaks", () => {
  const categories = [{ id: "main", name: "Обед" }];
  const items = Array.from({ length: 24 }, (_, index) => ({ id: `item-${index}`, categoryId: "main", name: `Очень длинное название блюда с дополнительным гарниром ${index}`, priceMinor: 123456789 }));
  const html = renderLegacyDisplay({ name: "Кафе", breakActive: true, breakEndsAt: "2020-01-01T00:00:00.000Z", breakExpiredText: "Скоро вернёмся" }, categories, items, 1920, 1080, "test", Date.now());
  assert.ok((html.match(/data-page="\d+"/g) ?? []).length > 1);
  assert.equal((html.match(/class="item"/g) ?? []).length, items.length);
  assert.match(html, /1234567,89 руб\./);
  assert.match(html, /\.main-row\{display:table;width:100%;table-layout:auto\}/);
  assert.match(html, /break-expired/);
  assert.match(html, /Скоро вернёмся/);
});

test("break text cannot end the menu script", () => {
  const html = renderLegacyDisplay({ breakActive: true, breakExpiredText: "</script><script>alert('x')</script>" }, [], [], 1366, 768, "test");
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<script>alert/);
});


test("legacy refresh retains the document on failure and replaces it after recovery", () => {
  const html = renderLegacyDisplay({ name: "Кафе" }, [], [], 1366, 768, "test");
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const requests: FakeXhr[] = [], timers: Array<() => void> = [], writes: string[] = [];
  const elements: Record<string, any> = {};
  class FakeXhr {
    readyState = 0; status = 0; responseText = "";
    onreadystatechange?: () => void; onerror?: () => void;
    constructor() { requests.push(this); }
    open() {} send() {}
    abort() { this.readyState = 4; this.status = 0; this.onreadystatechange?.(); }
    respond(status: number, text: string, state = 4) { this.status = status; this.responseText = text; this.readyState = state; this.onreadystatechange?.(); }
  }
  runInNewContext(script, {
    XMLHttpRequest: FakeXhr,
    window: { location: { href: "http://localhost/menu" } },
    document: { querySelectorAll: () => [], getElementById: (id: string) => elements[id] ??= { style: {} }, body: {}, open() {}, close() {}, write(value: string) { writes.push(value); } },
    setInterval() {}, clearInterval() {}, setTimeout(callback: () => void) { timers.push(callback); }, clearTimeout() {},
  });
  const changed = 'data: {"version":9,"breakActive":false,"breakEndsAt":null}\n\n';
  requests[0].respond(200, changed, 3);
  assert.equal(requests.length, 2);
  requests[1].respond(503, "unavailable");
  assert.deepEqual(writes, []);
  assert.equal(elements.offline.style.display, "block");
  timers.shift()!();
  requests[2].respond(200, changed, 3);
  requests[3].respond(200, "<!doctype html><html>Updated menu</html>");
  assert.deepEqual(writes, ["<!doctype html><html>Updated menu</html>"]);
});
