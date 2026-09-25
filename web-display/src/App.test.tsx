import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  staffLogin: vi.fn(),
  menu: vi.fn(),
  updateItemsAvailability: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    staffLogin: mocks.staffLogin,
    menu: mocks.menu,
    updateItemsAvailability: mocks.updateItemsAvailability,
    updateItem: vi.fn(),
    startBreak: vi.fn(),
    stopBreak: vi.fn(),
  },
}));

const { staffLogin, menu, updateItemsAvailability } = mocks;

const venue = {
  name: "Зимний сад", currency: "RUB", backgroundColor: "#56965B", accentColor: "#FFFFFF", logoPath: "",
  pageDurationSeconds: 10, breakDurationMinutes: 10, menuVersion: 4,
};
const categories = [{ id: "coffee", venueId: "venue-1", name: "Кофе", sortOrder: 1 }];
const items = [
  { id: "latte", venueId: "venue-1", categoryId: "coffee", name: "Латте", priceMinor: 25000, sortOrder: 1, isAvailable: true },
  { id: "tea", venueId: "venue-1", categoryId: "coffee", name: "Чай", priceMinor: 15000, sortOrder: 2, isAvailable: false },
];

describe("staff application flow", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    window.history.replaceState({}, "", "/staff");
    localStorage.clear();
    sessionStorage.clear();
    staffLogin.mockReset().mockResolvedValue({ token: "staff-token", venueId: "venue-1" });
    menu.mockReset().mockResolvedValue({ venue, categories, items });
    updateItemsAvailability.mockReset().mockResolvedValue({ updatedCount: 1, items: [{ ...items[0], isAvailable: false }], menuVersion: 5 });
  });

  async function login() {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Код точки"), { target: { value: "wintercafe123" } });
    fireEvent.change(screen.getByLabelText("Шестизначный PIN"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти в кабинет" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Зимний сад" })).toBeTruthy());
  }

  it("logs in and shows the daily dashboard with onboarding", async () => {
    await login();
    expect(screen.getByText("Быстрый старт")).toBeTruthy();
    expect(screen.getByText("Латте")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(screen.queryByText("Быстрый старт")).toBeNull();
  });

  it("filters availability by search and keeps the selected result actionable", async () => {
    await login();
    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск по позициям" }), { target: { value: "чай" } });
    expect(screen.getByText("Чай")).toBeTruthy();
    expect(screen.queryByText("Латте")).toBeNull();
    fireEvent.click(screen.getByLabelText("Выбрать показанные"));
    const toolbar = screen.getByLabelText("Выбрать показанные").closest("div");
    expect(toolbar).not.toBeNull();
    fireEvent.click(within(toolbar as HTMLElement).getByRole("button", { name: "В наличии" }));
    await waitFor(() => expect(updateItemsAvailability).toHaveBeenCalledWith("staff-token", ["tea"], true));
  });
});
