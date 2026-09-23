import type { Category, MenuItem, MenuPage, PageEntry } from "./types";

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
        .filter((item) => item.isAvailable !== false)
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

export function layoutForViewport(width: number, height: number) {
  const aspect = width / Math.max(1, height);
  const columnCount = width >= 1500 ? 3 : aspect >= 1.25 ? 2 : 1;
  // These are the baseline CSS pixels used by the display. The whole menu is
  // scaled uniformly, so viewport units here would be multiplied twice by
  // browser zoom and cause clipping on older TVs.
  const reservedHeight = width >= 900 ? 230 : 190;
  const rowHeight = width >= 1500 ? 86 : 78;
  return {
    columnCount,
    rowsPerColumn: Math.max(4, Math.floor((height - reservedHeight) / rowHeight)),
  };
}

export function autoScaleForMenu(categories: Category[], items: MenuItem[], width: number, height: number, maxPages = 2) {
  // Auto mode must remain legible on ordinary 1080p displays. Manual mode can
  // still use the full 50–160% range, while automatic mode grows only as far
  // as the viewport can comfortably render.
  const pagesAt = (scale: number) => {
    const layout = layoutForViewport(width / scale, height / scale);
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
  if (name.length > 54) return 0.62;
  if (name.length > 38) return 0.72;
  if (name.length > 24) return 0.84;
  return 1;
}
