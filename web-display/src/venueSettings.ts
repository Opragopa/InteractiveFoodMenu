export const logoPositions = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;
export type LogoPosition = typeof logoPositions[number];

export type VenueAppearance = {
  name: string;
  backgroundColor: string;
  accentColor: string;
  pageDurationSeconds: number;
  displayScalePercent: number;
  logoPosition: LogoPosition;
  logoInsetPercent: number;
  logoScalePercent: number;
  logoVisible?: boolean;
  menuRefreshSeconds?: number;
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
    pageDurationSeconds: clampInteger(value.pageDurationSeconds, 5, 60, 10),
    displayScalePercent: clampInteger(value.displayScalePercent, 50, 160, 100),
    logoPosition: value.logoPosition,
    logoInsetPercent: clampInteger(value.logoInsetPercent, 0, 20, 3),
    logoScalePercent: clampInteger(value.logoScalePercent, 50, 200, 100),
    logoVisible: value.logoVisible !== false,
    menuRefreshSeconds: clampInteger(value.menuRefreshSeconds, 5, 300, 15),
  };
}
