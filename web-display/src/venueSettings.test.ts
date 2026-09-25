import { describe, expect, it } from "vitest";
import { clampInteger, normalizeVenueAppearance, polytechAppearance } from "./venueSettings";

describe("venue appearance editor", () => {
  it("keeps an entered TV scale when saving the Hub form", () => {
    const settings = normalizeVenueAppearance({
      name: "Кафе Политех",
      backgroundColor: "#56965b",
      accentColor: "#ffffff",
      pageDurationSeconds: 15,
      displayScalePercent: 135,
      logoPosition: "bottom-left",
      logoInsetPercent: 8,
      logoScalePercent: 145,
      logoVisible: false,
      menuRefreshSeconds: 45,
      breakPanelWidthPercent: 36,
      breakMenuDimPercent: 45,
      menuItemFontSizePx: 34,
      menuItemGapPx: 12,
      breakTransitionMs: 600,
      displayPreset: "balanced",
      breakExpiredText: "Скоро буду",
    });
    expect(settings).toMatchObject({
      backgroundColor: "#56965B",
      accentColor: "#FFFFFF",
      pageDurationSeconds: 15,
      displayScalePercent: 135,
      logoPosition: "bottom-left",
      logoInsetPercent: 8,
      logoScalePercent: 145,
      logoVisible: false,
      menuRefreshSeconds: 45,
    });
  });

  it("limits numeric controls to the values accepted by the backend", () => {
    expect(clampInteger("4", 5, 60, 10)).toBe(5);
    expect(clampInteger("161", 50, 160, 100)).toBe(160);
    expect(clampInteger("120", 50, 160, 100)).toBe(120);
    expect(clampInteger("-2", 0, 20, 3)).toBe(0);
    expect(clampInteger("99", 0, 20, 3)).toBe(20);
    expect(clampInteger("175", 50, 200, 100)).toBe(175);
  });

  it("uses the approved default Polytech colors", () => {
    expect(polytechAppearance).toEqual({ backgroundColor: "#56965B", accentColor: "#FFFFFF" });
  });

  it("uses safe logo defaults when an older venue has no logo layout fields", () => {
    const settings = normalizeVenueAppearance({
      name: "Старая точка",
      backgroundColor: "#56965B",
      accentColor: "#FFFFFF",
      pageDurationSeconds: 10,
      displayScalePercent: 100,
      logoPosition: "top-right",
      logoInsetPercent: Number.NaN,
      logoScalePercent: Number.NaN,
    });
    expect(settings.logoInsetPercent).toBe(3);
    expect(settings.logoScalePercent).toBe(100);
    expect(settings.logoVisible).toBe(true);
    expect(settings.menuRefreshSeconds).toBe(15);
    expect(settings.breakPanelWidthPercent).toBe(36);
    expect(settings.breakMenuDimPercent).toBe(45);
    expect(settings.menuItemFontSizePx).toBe(34);
    expect(settings.menuItemGapPx).toBe(12);
    expect(settings.breakTransitionMs).toBe(600);
    expect(settings.displayPreset).toBe("balanced");
    expect(settings.breakExpiredText).toBe("Скоро буду");
  });
});
