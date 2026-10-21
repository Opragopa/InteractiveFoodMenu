import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendHub } from "./BackendHub";
const mocks = vi.hoisted(() => ({ login: vi.fn(), overview: vi.fn(), create: vi.fn(), logout: vi.fn() }));
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), api: { hubPasswordLogin: mocks.login, hubOverview: mocks.overview, hubCreateVenue: mocks.create, authLogout: mocks.logout } }));
const empty = { generatedAt: "2026-10-20", totals: { venues: 0, categories: 0, items: 0, activeDisplays: 0 }, venues: [], functions: [], clientLogs: [], auditLogs: [] };
afterEach(cleanup);
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.overview.mockResolvedValue(empty); mocks.logout.mockResolvedValue(undefined); });
describe("Hub action ordering", () => {
  it("accepts only one password login while Enter is pressed repeatedly", async () => {
    let finish!: (value: unknown) => void;
    mocks.login.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<BackendHub />);
    fireEvent.change(screen.getByLabelText("Логин"), { target: { value: "operator" } });
    const password = screen.getByLabelText("Пароль");
    fireEvent.change(password, { target: { value: "password" } });
    fireEvent.keyDown(password, { key: "Enter" }); fireEvent.keyDown(password, { key: "Enter" });
    expect(mocks.login).toHaveBeenCalledTimes(1);
    await act(async () => finish({ role: "hub" }));
    await screen.findByRole("heading", { name: "Точки и доступ" });
  });
  it("ignores the result of creating a venue after logout", async () => {
    localStorage.setItem("ifm-hub-session", "cookie");
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<BackendHub />);
    await screen.findByRole("heading", { name: "Новая точка" });
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Новая точка" } });
    fireEvent.change(screen.getByPlaceholderText("nevsky"), { target: { value: "new-venue" } });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать точку" }));
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    await act(async () => finish({ displayUrl: "https://example.test/#old-secret" }));
    expect(screen.getByRole("button", { name: "Войти в хаб" })).toBeTruthy();
    expect(screen.queryByText("Ссылка первого экрана")).toBeNull();
    expect(mocks.overview).toHaveBeenCalledTimes(1);
  });
});
