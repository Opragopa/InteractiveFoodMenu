import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FeedbackForm, VkrPanel } from "./VkrPanel";
const mock = vi.hoisted(() => ({ request: vi.fn(), download: vi.fn() }));
vi.mock("./api", () => ({
  request: mock.request,
  downloadFeedbackReport: mock.download,
}));
beforeEach(() => {
  mock.request.mockReset();
  mock.download.mockReset();
  history.replaceState({}, "", "/feedback?venue=stand-a");
});
afterEach(cleanup);
test("anonymous feedback validates required text and sends selected category", async () => {
  mock.request.mockImplementation(async (path: string) =>
    path.endsWith("/reviews")
      ? { id: "review", status: "new" }
      : { id: "venue", name: "Столовая А" },
  );
  render(<FeedbackForm />);
  await screen.findByText("Столовая А");
  expect((screen.getByText("Отправить") as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText("Причина"), {
    target: { value: "service" },
  });
  fireEvent.change(screen.getByLabelText("Сообщение"), {
    target: { value: "Тестовое обращение" },
  });
  fireEvent.click(screen.getByText("Отправить"));
  await screen.findByText("Спасибо. Обращение принято.");
  expect(mock.request).toHaveBeenCalledWith("/public/venues/stand-a/reviews", {
    method: "POST",
    body: JSON.stringify({
      message: "Тестовое обращение",
      category: "service",
    }),
  });
});
test("failed feedback keeps visitor text available for retry", async () => {
  mock.request.mockImplementation(async (path: string) => {
    if (path.endsWith("/reviews")) throw new Error("Нет связи");
    return { id: "venue", name: "Столовая А" };
  });
  render(<FeedbackForm />);
  await screen.findByText("Столовая А");
  fireEvent.change(screen.getByLabelText("Сообщение"), {
    target: { value: "Сохранённый текст" },
  });
  fireEvent.click(screen.getByText("Отправить"));
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("Сообщение") as HTMLTextAreaElement).value,
  ).toBe("Сохранённый текст");
});
test("auditor sees escaped text and history but cannot change feedback or grant access", async () => {
  const row = {
    id: "r1",
    venueId: "v1",
    message: "<script>alert(1)</script>",
    category: "service",
    status: "new",
    version: 1,
    createdAt: new Date().toISOString(),
  };
  mock.request.mockImplementation(async (path: string) => {
    if (path === "/hub/vkr/access")
      return {
        admin: false,
        actor: "operator:audit",
        organizations: [],
        grants: [{ organizationId: "o1", role: "auditor" }],
        venues: [
          { id: "v1", organizationId: "o1", code: "cafe", name: "Столовая" },
        ],
      };
    if (path.startsWith("/hub/reports/feedback"))
      return { total: 1, groups: [] };
    if (path.startsWith("/hub/reviews?")) return { reviews: [row] };
    if (path.endsWith("/assignees")) return { accounts: [] };
    if (path.endsWith("/actions")) return { actions: [] };
    throw new Error(`Unexpected ${path}`);
  });
  render(<VkrPanel token="cookie" />);
  await screen.findByText(row.message);
  expect(document.querySelector("script")).toBeNull();
  expect((screen.getByLabelText("Статус") as HTMLSelectElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByText("Сохранить действие") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByText("Создать аккаунт")).toBeNull();
  fireEvent.click(screen.getByText("Скачать CSV"));
  await waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
});
