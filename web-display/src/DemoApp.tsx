import { DisplayScreen } from "./DisplayScreen";
import type { Category, MenuItem, Venue } from "./types";

const venue: Venue = { name: "Кафе Север", currency: "RUB", backgroundColor: "#56965B", accentColor: "#FFFFFF", logoPath: "", pageDurationSeconds: 10, breakPanelWidthPercent: 36, breakMenuDimPercent: 45, menuItemFontSizePx: 34, menuItemGapPx: 12, breakTransitionMs: 600, breakExpiredText: "Скоро буду" };
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
  const mode = new URLSearchParams(window.location.search).get("break");
  const demoVenue: Venue = mode ? { ...venue, breakActive: true, breakEndsAt: mode === "expired" ? new Date(Date.now() - 1000).toISOString() : new Date(Date.now() + 9 * 60_000 + 42_000).toISOString() } : venue;
  return <DisplayScreen venue={demoVenue} categories={categories} items={items} logoUrl="/politech-logo-white.svg" connected />;
}
