import type { Category, MenuItem, MenuPage, PageEntry } from "./types";

export const MIN_DISPLAY_COLUMN_WIDTH = 580;

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

export function layoutForViewport(width: number, height: number, rowLayoutHeight = height) {
  const aspect = width / Math.max(1, height);
  const columnCount = Math.min(3, Math.max(1, Math.floor((width + 32) / (MIN_DISPLAY_COLUMN_WIDTH + 32))));
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

export function autoScaleForMenu(categories: Category[], items: MenuItem[], width: number, height: number, maxPages = 2) {
  // Auto mode must remain legible on ordinary 1080p displays. Manual mode can
  // still use the full 50–160% range, while automatic mode grows only as far
  // as the viewport can comfortably render.
  const pagesAt = (scale: number) => {
    const layout = layoutForViewport(width, height, height / scale);
    return paginateMenu(categories, items, layout.rowsPerColumn, layout.columnCount).length;
  };
  // Prefer a single complete screen. A sparse second page is harder to read
  // and wastes the available display area.
  for (let percent = 120; percent >= 50; percent -= 5) {
    const scale = percent / 100;
    if (pagesAt(scale) <= 1) return scale;
  }
  for (let percent = 120; percent >= 50; percent -= 5) {
    const scale = percent / 100;
    if (pagesAt(scale) <= maxPages) return scale;
  }
  return 0.5;
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
