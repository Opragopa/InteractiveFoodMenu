import assert from "node:assert/strict";
import test from "node:test";
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

test("break text cannot end the menu script", () => {
  const html = renderLegacyDisplay({ breakActive: true, breakExpiredText: "</script><script>alert('x')</script>" }, [], [], 1366, 768, "test");
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<script>alert/);
});
