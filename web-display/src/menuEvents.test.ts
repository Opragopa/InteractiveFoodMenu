import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subscribeMenu } from "./menuEvents";
class StreamXhr {
  static all: StreamXhr[] = [];
  readyState = 0; status = 0; responseText = ""; withCredentials = false;
  onreadystatechange?: () => void; onerror?: () => void;
  headers: Record<string, string> = {};
  constructor() { StreamXhr.all.push(this); }
  open() {}
  setRequestHeader(key: string, value: string) { this.headers[key] = value; }
  send() {}
  abort() { this.status = 0; this.readyState = 4; this.onreadystatechange?.(); }
  chunk(text: string) { this.status = 200; this.readyState = 3; this.responseText += text; this.onreadystatechange?.(); }
}
beforeEach(() => { vi.useFakeTimers(); StreamXhr.all = []; vi.stubGlobal("XMLHttpRequest", StreamXhr); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("handles split event frames and heartbeats without any idle requests", () => {
  const changed = vi.fn(), connection = vi.fn();
  const stop = subscribeMenu("/api/menu/events", "secret", changed, connection);
  const stream = StreamXhr.all[0];
  expect(stream.headers.Authorization).toBe("Bearer secret");
  stream.chunk('data: {"version":'); expect(changed).not.toHaveBeenCalled();
  stream.chunk('1}\n\n: keep-alive\n\n'); expect(changed).toHaveBeenCalledExactlyOnceWith({ version: 1 });
  vi.advanceTimersByTime(300000); expect(StreamXhr.all).toHaveLength(1);
  stop(); vi.advanceTimersByTime(120000); expect(StreamXhr.all).toHaveLength(1);
});
it("an online event replaces a broken stream without creating duplicate retries", () => {
  const stop = subscribeMenu("/events", "secret", vi.fn(), vi.fn());
  window.dispatchEvent(new Event("online"));
  expect(StreamXhr.all).toHaveLength(2);
  vi.advanceTimersByTime(120000); expect(StreamXhr.all).toHaveLength(2);
  StreamXhr.all[1].onerror?.();
  vi.advanceTimersByTime(4000); expect(StreamXhr.all).toHaveLength(3);
  stop();
});
it("stops reconnecting when access is revoked", () => {
  const changed = vi.fn();
  const stop = subscribeMenu("/events", "secret", changed, vi.fn());
  const stream = StreamXhr.all[0]; stream.status = 401; stream.readyState = 4; stream.onreadystatechange?.();
  vi.advanceTimersByTime(120000);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ revoked: true }); expect(StreamXhr.all).toHaveLength(1);
  stop();
});

it("closes the socket after a server revocation event", () => {
  const changed = vi.fn();
  const stop = subscribeMenu("/events", "secret", changed, vi.fn());
  StreamXhr.all[0].chunk('data: {"revoked":true}\n\n');
  vi.advanceTimersByTime(120000);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ revoked: true }); expect(StreamXhr.all).toHaveLength(1);
  stop();
});
