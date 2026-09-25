import type { MenuItem } from "./types";

export type AvailabilityFilter = "all" | "available" | "unavailable";

export function filterMenuItems(items: MenuItem[], query: string, categoryId: string, availability: AvailabilityFilter): MenuItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const matchesSearch = !normalized || item.name.toLocaleLowerCase().includes(normalized);
    const matchesCategory = !categoryId || item.categoryId === categoryId;
    const matchesAvailability = availability === "all" || (availability === "available" ? item.isAvailable : !item.isAvailable);
    return matchesSearch && matchesCategory && matchesAvailability;
  });
}

export function selectionIncludesAll(filteredIds: string[], selectedIds: Set<string>): boolean {
  return filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
}
