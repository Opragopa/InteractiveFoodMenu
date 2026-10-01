import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyDisplayScreen } from "./LegacyDisplayScreen";
import type { DisplayScreenProps } from "./DisplayScreen";

const props: DisplayScreenProps = {
  venue: { name: "Кафе", currency: "RUB", backgroundColor: "#56965B", accentColor: "#FFFFFF", logoPath: "", pageDurationSeconds: 5 },
  categories: [{ id: "c", venueId: "v", name: "Обед", sortOrder: 0 }],
  items: Array.from({ length: 6 }, (_, index) => ({ id: `i${index}`, venueId: "v", categoryId: "c", name: `Блюдо ${index}`, priceMinor: 15000, sortOrder: index, isAvailable: index !== 0 })),
  logoUrl: "/logo.svg", connected: true,
};

// jsdom has no layout engine. Model a one-column display and real measured
// row heights to exercise pagination and its timer, not CSS rendering.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains("tv-heading") ? 60 : 200 } as DOMRect;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("legacy screen states", () => {
  it("rotates measured pages, wraps around, and resets after the menu shrinks", async () => {
    const { container, rerender } = render(<LegacyDisplayScreen {...props} />);
    const visible = () => container.querySelector(".tv-page")!.textContent!;
    expect(container.querySelector(".tv-meta")!.textContent).toContain("1 / 3");
    expect(visible()).toContain("Блюдо 0");
    expect(visible()).not.toContain("Блюдо 2");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.querySelector(".tv-meta")!.textContent).toContain("2 / 3");
    expect(visible()).toContain("Блюдо 2");
    expect(visible()).toContain("продолжение");
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(visible()).toContain("Блюдо 0");
    rerender(<LegacyDisplayScreen {...props} items={props.items.slice(0, 1)} />);
    expect(container.querySelector(".tv-meta > span")).toBeNull();
    expect(visible()).toContain("Блюдо 0");
    expect(vi.getTimerCount()).toBe(1); // only the clock; pagination was stopped
  });

  it.each(["top-left", "top-right", "bottom-left", "bottom-right"] as const)("reserves space for the %s logo and honors hiding it", position => {
    const venue = { ...props.venue, logoPosition: position, logoScalePercent: 150, logoInsetPercent: 10 };
    const { container, rerender } = render(<LegacyDisplayScreen {...props} venue={venue} />);
    const logo = screen.getByRole("img") as HTMLImageElement;
    expect(logo.style[position.startsWith("top") ? "top" : "bottom"]).not.toBe("");
    expect(logo.style[position.endsWith("left") ? "left" : "right"]).not.toBe("");
    const reserve = container.querySelector(position.startsWith("top") ? ".tv-header" : ".tv-footer") as HTMLElement;
    const withLogo = parseFloat(reserve.style.height);
    rerender(<LegacyDisplayScreen {...props} venue={{ ...venue, logoVisible: false }} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(parseFloat(reserve.style.height)).toBeLessThan(withLogo);
  });

  it("keeps cached food visible offline with freshness and missing nutrition values", () => {
    const venue = { ...props.venue, showServingSize: true, showCalories: true, backgroundColor: "invalid", accentColor: "invalid" };
    const { container, rerender } = render(<LegacyDisplayScreen {...props} venue={venue} connected={false} />);
    expect(screen.getByText("Нет связи · показано последнее меню")).toBeTruthy();
    expect(container.querySelector(".tv-page .tv-row.unavailable")).toBeTruthy();
    expect(container.querySelector(".tv-page .tv-row-details")!.textContent).toBe("Выход: —— ккал");
    expect((container.querySelector(".tv-screen") as HTMLElement).style.backgroundColor).toBe("rgb(86, 150, 91)");
    rerender(<LegacyDisplayScreen {...props} venue={venue} connected={false} updatedAt={Date.now()} />);
    expect(screen.getByText(/Нет связи · меню актуально на/)).toBeTruthy();
    rerender(<LegacyDisplayScreen {...props} venue={venue} />);
    expect(container.querySelector(".tv-footer")!.textContent).toBe("");
  });

  it("recalculates column count when the TV viewport changes", () => {
    const { container } = render(<LegacyDisplayScreen {...props} />);
    expect(container.querySelectorAll(".tv-column")).toHaveLength(1);
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1920);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(1080);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(container.querySelectorAll(".tv-column")).toHaveLength(2);
    expect(container.querySelector(".tv-meta > span")).toBeNull();
  });
});
