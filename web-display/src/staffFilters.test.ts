import { describe, expect, it } from "vitest";
import { filterMenuItems, selectionIncludesAll } from "./staffFilters.js";
import type { MenuItem } from "./types.js";

const items = [
  { id: "1", categoryId: "coffee", name: "Капучино", isAvailable: true },
  { id: "2", categoryId: "coffee", name: "Латте", isAvailable: false },
  { id: "3", categoryId: "food", name: "Сэндвич", isAvailable: true },
] as MenuItem[];

describe("staff filters", () => {
  it("combine search, category and availability", () => {
    expect(filterMenuItems(items, "лат", "coffee", "unavailable").map((item) => item.id)).toEqual(["2"]);
    expect(filterMenuItems(items, "", "food", "all").map((item) => item.id)).toEqual(["3"]);
  });

  it("detect all filtered items", () => {
    expect(selectionIncludesAll(["1", "2"], new Set(["1", "2"]))).toBe(true);
    expect(selectionIncludesAll(["1", "2"], new Set(["1"]))).toBe(false);
    expect(selectionIncludesAll([], new Set())).toBe(false);
  });
});
