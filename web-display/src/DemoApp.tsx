import { DisplayScreen } from "./DisplayScreen";
import { VenueSettings } from "./App";
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
  servingSize: `${200 + index * 25} г`, caloriesKcal: 180 + categoryIndex * 60 + index * 25,
  isAvailable: name !== "Крем-суп грибной" && name !== "Домашний лимонад",
})));

export function DemoApp() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("break");
  const demoItems = params.has("stress") ? items.map((item, index) => index === 0 ? { ...item, name: "Филе цыплёнка с картофельным пюре и сливочным соусом", servingSize: "1/150/030", priceMinor: 123456789, caloriesKcal: 12345 } : item) : items;
  const demoVenue: Venue = {
    ...venue, showServingSize: params.has("serving"), showCalories: params.has("calories"),
    displayScaleMode: params.has("scale") ? "manual" : "auto",
    displayScalePercent: Number(params.get("scale") || 100),
    columnScale1Percent: Number(params.get("column1") || 100),
    columnScale2Percent: Number(params.get("column2") || 100),
    columnScale3Percent: Number(params.get("column3") || 100),
    ...(mode ? { breakActive: true, breakEndsAt: mode === "expired" ? new Date(Date.now() - 1000).toISOString() : new Date(Date.now() + 9 * 60_000 + 42_000).toISOString() } : {}),
  };
  if (params.has("staff-preview")) return <div className="staff-dashboard" style={{ height: "100%", overflowY: "auto" }}><VenueSettings venue={demoVenue} categories={categories} items={demoItems} busy={false} onSave={async () => {}} /></div>;
  return <DisplayScreen venue={demoVenue} categories={categories} items={demoItems} logoUrl="/politech-logo-white.svg" connected />;
}
