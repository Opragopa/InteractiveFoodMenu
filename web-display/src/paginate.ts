import type { Category, MenuItem, MenuPage, PageEntry } from "./types";

export const MIN_DISPLAY_COLUMN_WIDTH = 580;
const priceFormatter = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 });

// Leave room for a typical two-line name and a right-aligned price at the
// configured font size. Extra menu entries go to the next column or page.
export function menuValueWidths(items: MenuItem[], serving: boolean, calories: boolean) {
  const longestPrice = items.reduce((length, item) => Math.max(length, priceFormatter.format(item.priceMinor / 100).length), 0);
  const longestServing = serving ? items.reduce((length, item) => Math.max(length, (item.servingSize || "—").length), 0) : 0;
  const longestCalories = calories ? items.reduce((length, item) => Math.max(length, String(item.caloriesKcal ?? "—").length), 0) : 0;
  return { price: Math.max(6.5, longestPrice * .7 + 1), serving: serving ? Math.max(5, longestServing * .7 + 1) : 0, calories: calories ? Math.max(3, longestCalories * .7 + 1) : 0 };
}

export function minMenuColumnWidth(fontSize: number, items: MenuItem[] = [], serving = false, calories = false) {
  const longestName = items.reduce((length, item) => Math.max(length, item.name.length), 0);
  const twoLineWidth = longestName * fontSize * .54 / 2 + fontSize * 4.5 + 32;
  const widths = menuValueWidths(items, serving, calories);
  const detailWidth = (serving || calories) ? fontSize * (widths.serving + widths.price + widths.calories + 2) + 32 : 0;
  return Math.max(MIN_DISPLAY_COLUMN_WIDTH, Math.ceil(fontSize * 13 + 160), Math.ceil(twoLineWidth), Math.ceil(detailWidth));
}

export function paginateMenu(
  categories: Category[],
  items: MenuItem[],
  rowsPerColumn: number,
  columnCount: number,
): MenuPage[] {
  const rows = Math.max(2, Math.floor(rowsPerColumn));
  const columnsPerPage = Math.max(1, Math.floor(columnCount));
  const allColumns: PageEntry[][] = [];
  let column: PageEntry[] = [];

  const flush = () => {
    if (column.length) allColumns.push(column);
    column = [];
  };

  [...categories]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"))
    .forEach((category) => {
      const categoryItems = items
        .filter((item) => item.categoryId === category.id)
        .sort((a, b) => a.sortOrder - b.sortOrder
          || a.name.localeCompare(b.name, "ru"));
      if (!categoryItems.length) return;

      if (rows - column.length < 2) flush();
      column.push({ kind: "category", categoryId: category.id, name: category.name, repeated: false });
      categoryItems.forEach((item, index) => {
        if (column.length >= rows) {
          flush();
          column.push({
            kind: "category",
            categoryId: category.id,
            name: category.name,
            repeated: index > 0,
          });
        }
        column.push({ kind: "item", item });
      });
    });
  flush();

  if (!allColumns.length) return [];
  const pages: MenuPage[] = [];
  for (let index = 0; index < allColumns.length; index += columnsPerPage) {
    pages.push({ columns: allColumns.slice(index, index + columnsPerPage) });
  }
  return pages;
}

export function layoutForViewport(width: number, height: number, rowLayoutHeight = height, minColumnWidth = MIN_DISPLAY_COLUMN_WIDTH) {
  const aspect = width / Math.max(1, height);
  const columnCount = Math.min(3, Math.max(1, Math.floor((width + 32) / (minColumnWidth + 32))));
  const responsiveColumnCount = aspect >= 1.25 ? columnCount : 1;
  // These are the baseline CSS pixels used by the display. The whole menu is
  // scaled uniformly, so viewport units here would be multiplied twice by
  // browser zoom and cause clipping on older TVs.
  const reservedHeight = width >= 900 ? 230 : 190;
  const rowHeight = width >= 1500 ? 86 : 78;
  return {
    columnCount: responsiveColumnCount,
    rowsPerColumn: Math.max(4, Math.floor((rowLayoutHeight - reservedHeight) / rowHeight)),
  };
}

export function autoScaleForMenu(_categories: Category[], _items: MenuItem[], _width: number, _height: number) {
  // Pagination, rather than shrinking text to meet a page target, handles a
  // crowded menu. Existing manual percentages are applied by the callers.
  return 1;
}

export function itemNameScale(name: string) {
  void name;
  return 1;
}

export type EntryHeights = { category: number; item: (item: MenuItem) => number };

/**
 * Height-aware pagination used after the display has measured the rendered
 * rows. A section that fits in a fresh column is kept together. Oversized
 * sections continue in the next column with a repeated heading.
 */
export function paginateMenuByHeight(
  categories: Category[],
  items: MenuItem[],
  availableHeight: number,
  columnCount: number,
  heights: EntryHeights,
): MenuPage[] {
  const capacity = Math.max(1, availableHeight);
  const allColumns: PageEntry[][] = [];
  let column: PageEntry[] = [];
  let used = 0;

  const flush = () => {
    if (column.length) allColumns.push(column);
    column = [];
    used = 0;
  };

  [...categories]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"))
    .forEach((category) => {
      const categoryItems = items
        .filter((item) => item.categoryId === category.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"));
      if (!categoryItems.length) return;

      const sectionHeight = heights.category + categoryItems.reduce((sum, item) => sum + heights.item(item), 0);
      if (column.length && sectionHeight <= capacity && used + sectionHeight > capacity) flush();

      const addHeading = (repeated: boolean) => {
        column.push({ kind: "category", categoryId: category.id, name: category.name, repeated });
        used += heights.category;
      };
      if (column.length && used + heights.category + heights.item(categoryItems[0]) > capacity) flush();
      addHeading(false);

      categoryItems.forEach((item, index) => {
        const itemHeight = heights.item(item);
        if (column.length > 1 && used + itemHeight > capacity) {
          flush();
          addHeading(index > 0);
        }
        column.push({ kind: "item", item });
        used += itemHeight;
      });
    });
  flush();

  const pages: MenuPage[] = [];
  const columnsPerPage = Math.max(1, Math.floor(columnCount));
  for (let index = 0; index < allColumns.length; index += columnsPerPage) pages.push({ columns: allColumns.slice(index, index + columnsPerPage) });
  return pages;
}

export function estimateMenuPages(categories: Category[], items: MenuItem[], width: number, height: number, itemFontSizePx: number, itemGapPx: number) {
  const layout = layoutForViewport(width, height);
  const columnWidth = Math.max(240, (width - Math.max(0, layout.columnCount - 1) * 32) / layout.columnCount);
  const itemHeight = (item: MenuItem) => {
    const averageGlyphWidth = itemFontSizePx * .54;
    const textWidth = Math.max(120, columnWidth - 210);
    const lines = Math.max(1, Math.ceil(item.name.length * averageGlyphWidth / textWidth));
    return lines * itemFontSizePx * 1.2 + itemGapPx * 2;
  };
  return paginateMenuByHeight(categories, items, Math.max(180, height - 220), layout.columnCount, { category: 54, item: itemHeight }).length;
}
