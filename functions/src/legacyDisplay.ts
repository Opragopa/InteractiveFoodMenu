export type LegacyCategory = { id: string; name: string; sortOrder?: number };
export type LegacyMenuItem = {
  id: string;
  categoryId: string;
  name: string;
  priceMinor?: number;
  sortOrder?: number;
  isAvailable?: boolean;
};

export type LegacyDisplayEntry =
  | { kind: "category"; id: string; name: string; repeated: boolean }
  | { kind: "item"; item: LegacyMenuItem };

/** Keep every menu item, grouping available items first within each category. */
export function paginateLegacyDisplay(
  categories: LegacyCategory[],
  items: LegacyMenuItem[],
  rowsPerColumn = 18,
  columnsPerPage = 2,
): LegacyDisplayEntry[][][] {
  const rowLimit = Math.max(3, Math.floor(rowsPerColumn));
  const columnLimit = Math.max(1, Math.floor(columnsPerPage));
  const columns: LegacyDisplayEntry[][] = [];
  let column: LegacyDisplayEntry[] = [];
  const flush = () => {
    if (column.length) columns.push(column);
    column = [];
  };

  [...categories]
    .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || a.name.localeCompare(b.name, "ru"))
    .forEach((category) => {
      const categoryItems = items
        .filter((item) => item.categoryId === category.id)
        .sort((a, b) => Number(a.isAvailable === false) - Number(b.isAvailable === false)
          || Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)
          || a.name.localeCompare(b.name, "ru"));
      if (!categoryItems.length) return;

      if (rowLimit - column.length < 2) flush();
      column.push({ kind: "category", id: category.id, name: category.name, repeated: false });
      categoryItems.forEach((item, index) => {
        if (column.length >= rowLimit) {
          flush();
          column.push({ kind: "category", id: category.id, name: category.name, repeated: index > 0 });
        }
        column.push({ kind: "item", item });
      });
    });
  flush();

  const pages: LegacyDisplayEntry[][][] = [];
  for (let index = 0; index < columns.length; index += columnLimit) {
    pages.push(columns.slice(index, index + columnLimit));
  }
  return pages;
}
