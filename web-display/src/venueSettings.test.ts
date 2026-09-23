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
    });
    expect(settings).toMatchObject({
      backgroundColor: "#56965B",
      accentColor: "#FFFFFF",
      pageDurationSeconds: 15,
      displayScalePercent: 135,
      logoPosition: "bottom-left",
    });
  });

  it("limits numeric controls to the values accepted by the backend", () => {
    expect(clampInteger("4", 5, 60, 10)).toBe(5);
    expect(clampInteger("161", 50, 160, 100)).toBe(160);
    expect(clampInteger("120", 50, 160, 100)).toBe(120);
  });

  it("uses the approved default Polytech colors", () => {
    expect(polytechAppearance).toEqual({ backgroundColor: "#56965B", accentColor: "#FFFFFF" });
  });
});
