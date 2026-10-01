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
  assert.match(enlarged, /\.price\{display:block;flex:0 0 auto;width:auto/);
});

test("server-rendered menu reflows into the space beside the break panel", () => {
  const categories = [{ id: "main", name: "Горячие блюда" }];
  const items = Array.from({ length: 10 }, (_, index) => ({ id: `item-${index}`, categoryId: "main", name: `Блюдо с длинным названием ${index}`, priceMinor: 25000 }));
  const venue = { name: "Кафе", displayScaleMode: "manual", displayScalePercent: 100, breakPanelWidthPercent: 40 };
  const normal = renderLegacyDisplay(venue, categories, items, 1366, 768, "test");
  const active = renderLegacyDisplay({ ...venue, breakActive: true }, categories, items, 1366, 768, "test");
  const contentWidth = (html: string) => Number(html.match(/\.pages\{height:88%;width:([\d.]+)px\}/)?.[1]);
  assert.ok(contentWidth(active) < contentWidth(normal) * .65);
  assert.match(active, /\.break\.active\{display:block;left:60%\}/);
  assert.match(active, /font-size:calc\(20px \* var\(--column-scale\)\)/);
  assert.equal((active.match(/class="item"/g) ?? []).length, items.length);
});
