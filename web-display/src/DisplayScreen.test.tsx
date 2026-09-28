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
});
