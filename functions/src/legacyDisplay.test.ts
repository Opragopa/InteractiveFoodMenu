import test from "node:test";
import assert from "node:assert/strict";
import { paginateLegacyDisplay } from "./legacyDisplay.js";

const categories = [{ id: "hot", name: "Горячее", sortOrder: 0 }];

test("keeps a category visible when all of its items are unavailable", () => {
  const pages = paginateLegacyDisplay(categories, [
    { id: "a", categoryId: "hot", name: "Суп", isAvailable: false },
    { id: "b", categoryId: "hot", name: "Паста", isAvailable: false },
  ]);
  assert.deepEqual(pages[0][0].map((entry) => entry.kind === "category" ? entry.name : entry.item.name), [
    "Горячее", "Паста", "Суп",
  ]);
});

test("places unavailable items after available items within their category", () => {
  const pages = paginateLegacyDisplay(categories, [
    { id: "off", categoryId: "hot", name: "Суп", sortOrder: 0, isAvailable: false },
    { id: "on", categoryId: "hot", name: "Паста", sortOrder: 1, isAvailable: true },
  ]);
  assert.deepEqual(pages[0][0].filter((entry) => entry.kind === "item").map((entry) => entry.item.name), ["Паста", "Суп"]);
});

test("splits long menus into pages without losing items", () => {
  const items = Array.from({ length: 22 }, (_, index) => ({
    id: `item-${index}`, categoryId: "hot", name: `Позиция ${index}`, sortOrder: index, isAvailable: index !== 21,
  }));
  const pages = paginateLegacyDisplay(categories, items, 8, 2);
  const renderedIds = pages.flat(2).filter((entry) => entry.kind === "item").map((entry) => entry.item.id);
  assert.equal(pages.length, 2);
  assert.equal(renderedIds.length, items.length);
  assert.equal(new Set(renderedIds).size, items.length);
});
