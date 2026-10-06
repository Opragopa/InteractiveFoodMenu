import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, VenueSettings } from "./App";

const mocks = vi.hoisted(() => ({
  staffLogin: vi.fn(),
  displayLogin: vi.fn(),
  menuVersion: vi.fn(),
  menu: vi.fn(),
  updateItem: vi.fn(),
  adjustItemStock: vi.fn(),
  createItem: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    staffLogin: mocks.staffLogin,
    displayLogin: mocks.displayLogin,
    menuVersion: mocks.menuVersion,
    menu: mocks.menu,
    updateItem: mocks.updateItem,
    adjustItemStock: mocks.adjustItemStock,
    createItem: mocks.createItem,
    startBreak: vi.fn(),
    stopBreak: vi.fn(),
  },
}));

const { staffLogin, menu, updateItem, adjustItemStock, createItem } = mocks;

const venue = {
  name: "Зимний сад", currency: "RUB" as const, backgroundColor: "#56965B", accentColor: "#FFFFFF", logoPath: "",
  pageDurationSeconds: 10, breakDurationMinutes: 10, menuVersion: 4,
};
const categories = [{ id: "coffee", venueId: "venue-1", name: "Кофе", sortOrder: 1 }];
const items = [
  { id: "latte", venueId: "venue-1", categoryId: "coffee", name: "Латте", priceMinor: 25000, sortOrder: 1, isAvailable: true, stockQuantity: 1 },
  { id: "tea", venueId: "venue-1", categoryId: "coffee", name: "Чай", priceMinor: 15000, sortOrder: 2, isAvailable: false, stockQuantity: 0 },
];

describe("staff application flow", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    window.history.replaceState({}, "", "/staff");
    localStorage.clear();
    sessionStorage.clear();
    staffLogin.mockReset().mockResolvedValue({ token: "staff-token", venueId: "venue-1" });
    menu.mockReset().mockResolvedValue({ venue, categories, items });
    updateItem.mockReset().mockResolvedValue({ item: { ...items[1], stockQuantity: 2, isAvailable: true } });
    adjustItemStock.mockReset().mockResolvedValue({ item: { ...items[1], stockQuantity: 1, isAvailable: true } });
    createItem.mockReset();
  });

  async function login() {
    render(<App />);
    expect(document.title).toBe("Кабинет сотрудника — InteractiveFoodMenu");
    fireEvent.change(screen.getByLabelText("Код точки"), { target: { value: "wintercafe123" } });
    fireEvent.change(screen.getByLabelText("Шестизначный PIN"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти в кабинет" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Зимний сад" })).toBeTruthy());
  }

  it("logs in and shows the daily dashboard with onboarding", async () => {
    await login();
    expect(document.title).toBe("Кабинет сотрудника — Зимний сад");
    expect(screen.getByText("Быстрый старт")).toBeTruthy();
    expect(screen.getByText("Латте")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(screen.queryByText("Быстрый старт")).toBeNull();
  });

  it("filters availability and lets staff set, add and remove stock", async () => {
    await login();
    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск по позициям" }), { target: { value: "чай" } });
    expect(screen.getByText("Чай")).toBeTruthy();
    expect(screen.queryByText("Латте")).toBeNull();
    expect(screen.getByText("0 шт.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Списать одну штуку Чай" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Задать остаток Чай" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith("staff-token", "tea", { stockQuantity: 2 }));
    expect(screen.getByText("2 шт.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Списать одну штуку Чай" }));
    await waitFor(() => expect(adjustItemStock).toHaveBeenCalledWith("staff-token", "tea", -1));
    expect(screen.getByText("1 шт.")).toBeTruthy();
  });

  it("updates only the stock of a matching CSV item", async () => {
    await login();
    fireEvent.click(screen.getByRole("button", { name: "Позиции" }));
    const file = new File(["Категория;Название;Цена;Количество\nКофе; ЛАТТЕ ;999;5"], "stock.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => "Категория;Название;Цена;Количество\nКофе; ЛАТТЕ ;999;5" });
    fireEvent.change(screen.getByLabelText("Загрузить CSV"), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "Импортировать 1 поз." }));
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith("staff-token", "latte", { stockQuantity: 5 }));
    expect(createItem).not.toHaveBeenCalled();
  });

  it("reports ambiguous CSV matches without updating either item", async () => {
    menu.mockResolvedValue({ venue, categories, items: [...items, { ...items[0], id: "latte-copy", name: "латте" }] });
    await login();
    fireEvent.click(screen.getByRole("button", { name: "Позиции" }));
    const file = new File(["category,name,price,quantity\nКофе,Латте,250,5"], "stock.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => "category,name,price,quantity\nКофе,Латте,250,5" });
    fireEvent.change(screen.getByLabelText("Загрузить CSV"), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "Импортировать 1 поз." }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Строка 2: найдено несколько позиций"));
    expect(updateItem).not.toHaveBeenCalled();
    expect(createItem).not.toHaveBeenCalled();
  });
});

describe("hub page title", () => {
  afterEach(() => cleanup());

  it("identifies the hub on its browser tab", () => {
    window.history.replaceState({}, "", "/hub");
    localStorage.clear();
    render(<App />);
    expect(document.title).toBe("Хаб — InteractiveFoodMenu");
  });
});

describe("TV settings preview", () => {
  afterEach(() => cleanup());

  it("renders the actual menu with both nutrition columns and updates before save", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<VenueSettings venue={{ ...venue, showServingSize: true, showCalories: true, displayScaleMode: "auto" }} categories={categories} items={[{ ...items[0], servingSize: "250 г", caloriesKcal: 180 }]} busy={false} onSave={save} />);
    expect(container.querySelector(".real-display-preview .display-shell")).toBeTruthy();
    expect(container.querySelector(".real-display-preview .menu-item.has-serving.has-calories")).toBeTruthy();
    expect(container.querySelector(".experimental-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Увеличить размер текста" }));
    expect((container.querySelector(".real-display-preview .display-shell") as HTMLElement).style.getPropertyValue("--item-font-size")).toBe("35px");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("display links after nginx redirect", () => {
  afterEach(() => cleanup());
  it.each(["/", "/connect", "/connect/"])("opens the menu from %s with a display hash", async path => {
    window.history.replaceState({}, "", `${path}#pairingtoken123.abcdEFGH0123456789abcdEFGH0123456789`);
    mocks.displayLogin.mockResolvedValue({ token: "screen-token" });
    mocks.menu.mockResolvedValue({ venue, categories, items });
    mocks.menuVersion.mockResolvedValue({ version: 4 });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Зимний сад" })).toBeTruthy());
    expect(document.title).toBe("Меню — Зимний сад");
    expect(mocks.displayLogin).toHaveBeenCalledWith("pairingtoken123", "abcdEFGH0123456789abcdEFGH0123456789");
    expect(screen.queryByText("Подключение экрана")).toBeNull();
  });
});
