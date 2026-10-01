import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayScreen } from "./DisplayScreen";
import type { Venue } from "./types";

const venue: Venue = {
  name: "Кафе Полис", currency: "RUB", backgroundColor: "#FFFFFF", accentColor: "#56965B", logoPath: "",
  pageDurationSeconds: 10, breakActive: true, breakEndsAt: "", breakExpiredText: "Скоро буду",
};

describe("display break timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the displayed countdown aligned with the end timestamp", async () => {
    const endsAt = new Date(Date.now() + 65_000).toISOString();
    render(<DisplayScreen venue={{ ...venue, breakEndsAt: endsAt }} categories={[]} items={[]} logoUrl="" connected />);

    expect(screen.getByText("1:05")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_050); });
    expect(screen.getByText("1:03")).toBeTruthy();
  });

  it("shows the configured message as soon as the break reaches zero", async () => {
    const endsAt = new Date(Date.now() + 1_000).toISOString();
    render(<DisplayScreen venue={{ ...venue, breakEndsAt: endsAt }} categories={[]} items={[]} logoUrl="" connected />);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(screen.getByText("Скоро буду")).toBeTruthy();
  });

  it("fits the menu beside the break panel and restores full width afterwards", () => {
    const { container, rerender } = render(<DisplayScreen venue={{ ...venue, breakActive: false, breakPanelWidthPercent: 40, displayScaleMode: "manual", displayScalePercent: 100 }} categories={[]} items={[]} logoUrl="" connected />);
    const menu = container.querySelector(".display-menu") as HTMLElement;
    const fullWidth = parseFloat(menu.style.width) * parseFloat(menu.style.zoom);
    rerender(<DisplayScreen venue={{ ...venue, breakPanelWidthPercent: 40, displayScaleMode: "manual", displayScalePercent: 100 }} categories={[]} items={[]} logoUrl="" connected />);
    expect(parseFloat(menu.style.width) * parseFloat(menu.style.zoom)).toBeCloseTo(fullWidth * .6);
    expect(menu.style.zoom).toBe("0.6");
    rerender(<DisplayScreen venue={{ ...venue, breakActive: false, breakPanelWidthPercent: 40, displayScaleMode: "manual", displayScalePercent: 100 }} categories={[]} items={[]} logoUrl="" connected />);
    expect(parseFloat(menu.style.width) * parseFloat(menu.style.zoom)).toBeCloseTo(fullWidth);
    expect(menu.style.zoom).toBe("1");
  });
});

describe("legacy display", () => {
  beforeEach(() => {
    document.documentElement.classList.add("legacy-tv");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
  });
  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove("legacy-tv");
    vi.useRealTimers();
  });
  it("applies staff nutrition changes to visible rows and pagination measurements", () => {
    const props = { venue: { ...venue, breakActive: false }, categories: [{ id: "c1", venueId: "v1", name: "Обед", sortOrder: 0 }], items: [{ id: "i1", venueId: "v1", categoryId: "c1", name: "Суп", priceMinor: 15000, servingSize: "250 г", caloriesKcal: 120, sortOrder: 0, isAvailable: true }], logoUrl: "", connected: true };
    const { container, rerender } = render(<DisplayScreen {...props} />);
    expect(container.querySelector(".tv-page .tv-row-details")).toBeNull();
    rerender(<DisplayScreen {...props} venue={{ ...props.venue, showServingSize: true, showCalories: true }} />);
    expect(container.querySelector(".tv-page .tv-row-details")?.textContent).toBe("Выход: 250 г120 ккал");
    expect(container.querySelector(".tv-measure .tv-row-details")?.textContent).toBe("Выход: 250 г120 ккал");
  });
  it("finishes the break timer and uses the configured panel width", async () => {
    const { container } = render(<DisplayScreen venue={{ ...venue, breakEndsAt: new Date(Date.now() + 1000).toISOString(), breakPanelWidthPercent: 48 }} categories={[]} items={[]} logoUrl="" connected />);
    expect(screen.getByText("0:01")).toBeTruthy();
    expect((container.querySelector(".tv-break") as HTMLElement).style.width).toBe("48%");
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(screen.getByText("Скоро буду")).toBeTruthy();
  });
});
