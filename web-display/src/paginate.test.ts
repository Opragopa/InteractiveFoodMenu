import { describe, expect, it } from "vitest";
import { autoScaleForMenu, itemNameScale, layoutForViewport, paginateMenu } from "./paginate";
import { contrastForeground } from "./DisplayScreen";
import type { Category, MenuItem } from "./types";

const categories: Category[] = [{ id: "c1", venueId: "v", name: "Кухня", sortOrder: 0 }];
const items: MenuItem[] = Array.from({ length: 7 }, (_, index) => ({
  id: `i${index}`,
  venueId: "v",
  categoryId: "c1",
  name: `Блюдо ${index}`,
  priceMinor: 10000,
  sortOrder: index,
  isAvailable: true,
}));

describe("paginateMenu", () => {
  it("never exceeds row capacity and repeats split category titles", () => {
    const pages = paginateMenu(categories, items, 4, 2);
    const columns = pages.flatMap((page) => page.columns);
    expect(columns.every((column) => column.length <= 4)).toBe(true);
    expect(columns).toHaveLength(3);
    expect(columns[1][0]).toMatchObject({ kind: "category", repeated: true });
  });

  it("returns no pages for categories without items", () => {
    expect(paginateMenu(categories, [], 5, 3)).toEqual([]);
  });

  it("hides unavailable positions", () => {
    const items = [
      { ...itemsFixture("off", false), sortOrder: 0 },
      { ...itemsFixture("on", true), sortOrder: 1 },
    ];
    const pages = paginateMenu(categories, items, 5, 1);
    expect(pages[0].columns[0].map((entry) => entry.kind === "item" ? entry.item.id : entry.kind)).toEqual(["category", "on"]);
  });

  it("removes categories when every position is unavailable", () => {
    const pages = paginateMenu(categories, [itemsFixture("off-1", false), itemsFixture("off-2", false)], 5, 1);
    expect(pages).toEqual([]);
  });

  it("uses three columns for Full HD and two for 1366 wide", () => {
    expect(layoutForViewport(1920, 1080).columnCount).toBe(3);
    expect(layoutForViewport(1366, 768).columnCount).toBe(2);
  });

  it("keeps automatic scale in a legible range", () => {
    expect(autoScaleForMenu(categories, items, 1920, 1080)).toBeLessThanOrEqual(1.2);
    expect(itemNameScale("Очень длинное название блюда с большим количеством слов")).toBeLessThan(1);
  });
});

function itemsFixture(id: string, isAvailable: boolean): MenuItem {
  return { id, venueId: "v", categoryId: "c1", name: id, priceMinor: 100, sortOrder: 0, isAvailable };
}

describe("contrastForeground", () => {
  it("selects readable text for light and dark backgrounds", () => {
    expect(contrastForeground("#F7F4EE")).toBe("#201F1C");
    expect(contrastForeground("#151515")).toBe("#FFFFFF");
  });
});
