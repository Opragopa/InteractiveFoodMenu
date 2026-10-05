import { itemIsAvailable, type MenuItem } from "./types";

export type AvailabilityFilter = "all" | "available" | "unavailable";

export function filterMenuItems(items: MenuItem[], query: string, categoryId: string, availability: AvailabilityFilter): MenuItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const matchesSearch = !normalized || item.name.toLocaleLowerCase().includes(normalized);
    const matchesCategory = !categoryId || item.categoryId === categoryId;
    const matchesAvailability = availability === "all" || (availability === "available" ? itemIsAvailable(item) : !itemIsAvailable(item));
    return matchesSearch && matchesCategory && matchesAvailability;
  });
}
