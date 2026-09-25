export const logoPositions = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;
export type LogoPosition = typeof logoPositions[number];

export type VenueAppearance = {
  name: string;
  backgroundColor: string;
  accentColor: string;
  pageDurationSeconds: number;
  displayScalePercent: number;
  displayScaleMode?: "auto" | "manual";
  logoPosition: LogoPosition;
  logoInsetPercent: number;
  logoScalePercent: number;
  logoVisible?: boolean;
  menuRefreshSeconds?: number;
  breakFontSizePercent?: number;
  breakPanelWidthPercent?: number;
  breakMenuDimPercent?: number;
  menuItemFontSizePx?: number;
  menuItemGapPx?: number;
  breakTransitionMs?: number;
  displayPreset?: DisplayPreset;
  breakExpiredText?: string;
};

export type DisplayPreset = "compact" | "balanced" | "large";
export const displayPresets: Record<DisplayPreset, Pick<VenueAppearance, "breakPanelWidthPercent" | "breakMenuDimPercent" | "menuItemFontSizePx" | "menuItemGapPx" | "pageDurationSeconds" | "breakTransitionMs">> = {
  compact: { breakPanelWidthPercent: 32, breakMenuDimPercent: 35, menuItemFontSizePx: 28, menuItemGapPx: 6, pageDurationSeconds: 8, breakTransitionMs: 400 },
  balanced: { breakPanelWidthPercent: 36, breakMenuDimPercent: 45, menuItemFontSizePx: 34, menuItemGapPx: 12, pageDurationSeconds: 10, breakTransitionMs: 600 },
  large: { breakPanelWidthPercent: 42, breakMenuDimPercent: 55, menuItemFontSizePx: 42, menuItemGapPx: 18, pageDurationSeconds: 14, breakTransitionMs: 800 },
};

export const polytechAppearance = { backgroundColor: "#56965B", accentColor: "#FFFFFF" };

export function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

export function normalizeVenueAppearance(value: VenueAppearance): VenueAppearance {
  const name = value.name.trim();
  if (!name || name.length > 160) throw new Error("Название должно содержать от 1 до 160 символов.");
  const backgroundColor = value.backgroundColor.toUpperCase();
  const accentColor = value.accentColor.toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(backgroundColor) || !/^#[0-9A-F]{6}$/.test(accentColor)) throw new Error("Укажите цвета в формате #RRGGBB.");
  if (!logoPositions.includes(value.logoPosition)) throw new Error("Выберите расположение логотипа.");
  return {
    name,
    backgroundColor,
    accentColor,
    pageDurationSeconds: clampInteger(value.pageDurationSeconds, 5, 30, 10),
    displayScalePercent: clampInteger(value.displayScalePercent, 50, 160, 100),
    displayScaleMode: value.displayScaleMode === "manual" ? "manual" : "auto",
    logoPosition: value.logoPosition,
    logoInsetPercent: clampInteger(value.logoInsetPercent, 0, 20, 3),
    logoScalePercent: clampInteger(value.logoScalePercent, 50, 200, 100),
    logoVisible: value.logoVisible !== false,
    menuRefreshSeconds: clampInteger(value.menuRefreshSeconds, 5, 300, 15),
    breakFontSizePercent: clampInteger(value.breakFontSizePercent, 50, 200, 100),
    breakPanelWidthPercent: clampInteger(value.breakPanelWidthPercent, 30, 50, 36),
    breakMenuDimPercent: clampInteger(value.breakMenuDimPercent, 25, 75, 45),
    menuItemFontSizePx: clampInteger(value.menuItemFontSizePx, 22, 54, 34),
    menuItemGapPx: clampInteger(value.menuItemGapPx, 4, 28, 12),
    breakTransitionMs: clampInteger(value.breakTransitionMs, 200, 1200, 600),
    displayPreset: value.displayPreset && value.displayPreset in displayPresets ? value.displayPreset : "balanced",
    breakExpiredText: String(value.breakExpiredText ?? "Скоро буду").trim().slice(0, 80) || "Скоро буду",
  };
}
