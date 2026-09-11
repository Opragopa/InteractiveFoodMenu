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
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"));
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
  const columnCount = width >= 1500 ? 3 : width >= 900 ? 2 : 1;
  const reservedHeight = width >= 900 ? 230 : 190;
  // A row reserves enough room for a two-line title. Very long names can grow
  // further instead of being ellipsized, while this keeps normal pages airy.
  const rowHeight = width >= 1500 ? 86 : 76;
  return {
    columnCount,
    rowsPerColumn: Math.max(4, Math.floor((height - reservedHeight) / rowHeight)),
  };
}
