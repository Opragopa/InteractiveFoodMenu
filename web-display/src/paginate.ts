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
  const reservedHeight = width >= 900 ? 190 : 150;
  const rowHeight = width >= 1500 ? 72 : 66;
  return {
    columnCount,
    rowsPerColumn: Math.max(4, Math.floor((height - reservedHeight) / rowHeight)),
  };
}

export function autoScaleForMenu(categories: Category[], items: MenuItem[], width: number, height: number, maxPages = 2) {
  // Auto mode must remain legible on ordinary 1080p displays. Manual mode can
  // still use the full 50–160% range, while automatic mode grows only as far
  // as the viewport can comfortably render.
  for (let percent = 120; percent >= 50; percent -= 5) {
    const scale = percent / 100;
    const layout = layoutForViewport(width / scale, height / scale);
    if (paginateMenu(categories, items, layout.rowsPerColumn, layout.columnCount).length <= maxPages) return scale;
  }
  return 0.5;
}

export function itemNameScale(name: string) {
  if (name.length > 60) return 0.68;
  if (name.length > 42) return 0.78;
  if (name.length > 28) return 0.88;
  return 1;
}
