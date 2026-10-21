import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "./api";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("API deadline and uncertain writes", () => {
  it("aborts an unanswered write after 15 seconds without resending it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
    vi.stubGlobal("fetch", fetchMock);
    const pending = api.adjustItemStock("cookie", "item", -1);
    const assertion = expect(pending).rejects.toMatchObject({ status: 0, outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps the deadline until the successful response body has finished", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options) => Promise.resolve({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))) })));
    const pending = api.adjustItemStock("cookie", "item", -1);
    const assertion = expect(pending).rejects.toMatchObject({ status: 0, outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });
  it("treats malformed successful write responses as an unknown result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }));
    await expect(api.adjustItemStock("cookie", "item", -1)).rejects.toMatchObject({ status: 0, outcomeUnknown: true });
  });
  it("gives legacy XHR the same deadline and reports unknown write outcomes", async () => {
    vi.stubGlobal("fetch", undefined);
    let xhr: any;
    vi.stubGlobal("XMLHttpRequest", class { timeout = 0; open() {} setRequestHeader() {} send() { xhr = this; } });
    const pending = api.adjustItemStock("cookie", "item", -1);
    expect(xhr.timeout).toBe(15000);
    xhr.ontimeout();
    await expect(pending).rejects.toMatchObject({ status: 0, outcomeUnknown: true });
  });
  it("preserves a legacy XHR HTTP rejection when the JSON body is null", async () => {
    vi.stubGlobal("fetch", undefined);
    let xhr: any;
    vi.stubGlobal("XMLHttpRequest", class { timeout = 0; open() {} setRequestHeader() {} send() { xhr = this; } });
    const pending = api.adjustItemStock("cookie", "item", -1);
    const assertion = expect(pending).rejects.toMatchObject({ status: 401, outcomeUnknown: false });
    Object.assign(xhr, { readyState: 4, status: 401, responseText: "null" });
    xhr.onreadystatechange();
    await assertion;
  });
  it("preserves a definite HTTP rejection even when its body is unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 409, ok: false, json: async () => { throw new TypeError("disconnected"); } }));
    await expect(api.adjustItemStock("cookie", "item", -1)).rejects.toMatchObject({ status: 409, outcomeUnknown: false });
  });
  it("does not label a definite HTTP rejection as an uncertain mutation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 409, ok: false, json: async () => ({ message: "Остаток равен нулю" }) }));
    await expect(api.adjustItemStock("cookie", "item", -1)).rejects.toBeInstanceOf(ApiRequestError);
  });
});
