import { DisplayScreen } from "./DisplayScreen";
import type { Category, MenuItem, Venue } from "./types";

const venue: Venue = { name: "Кафе Север", currency: "RUB", backgroundColor: "#56965B", accentColor: "#FFFFFF", logoPath: "", pageDurationSeconds: 60 };
const categories: Category[] = ["Завтраки", "Супы", "Горячее", "Напитки"].map((name, index) => ({ id: `c${index}`, venueId: "demo", name, sortOrder: index }));
const names = [
  ["Сырники со сметаной", "Омлет с томатами", "Каша овсяная", "Круассан с лососем"],
  ["Борщ с говядиной", "Крем-суп грибной", "Куриный бульон"],
  ["Паста с морепродуктами", "Котлета с картофельным пюре", "Лосось с овощами", "Ризотто с грибами"],
  ["Капучино", "Чай облепиховый", "Домашний лимонад", "Вода"],
];
const items: MenuItem[] = names.flatMap((group, categoryIndex) => group.map((name, index) => ({
  id: `i${categoryIndex}-${index}`, venueId: "demo", categoryId: `c${categoryIndex}`, name,
  priceMinor: (190 + categoryIndex * 120 + index * 45) * 100, sortOrder: index,
  isAvailable: name !== "Крем-суп грибной" && name !== "Домашний лимонад",
})));

export function DemoApp() {
  return <DisplayScreen venue={venue} categories={categories} items={items} logoUrl="/politech-logo-white.svg" connected />;
}
