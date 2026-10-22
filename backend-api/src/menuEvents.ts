import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

export class MenuEvents {
  available = true;
  private emitter = new EventEmitter().setMaxListeners(0);
  private cache = new Map<string, Promise<unknown>>();
  cached<T>(venueId: string, load: () => Promise<T>): Promise<T> {
    if (!this.available) return load();
    const existing = this.cache.get(venueId); if (existing) return existing as Promise<T>;
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    const pending = load(); this.cache.set(venueId, pending);
    void pending.catch(() => { if (this.cache.get(venueId) === pending) this.cache.delete(venueId); });
    return pending;
  }
  publish(venueId: string) { if (venueId === "*") this.cache.clear(); else this.cache.delete(venueId); this.emitter.emit("change", venueId); }
  subscribe(venueId: string, callback: () => void) {
    const onChange = (id: string) => { if (id === venueId || id === "*") callback(); };
    this.emitter.on("change", onChange);
    return () => this.emitter.off("change", onChange);
  }
  onDisconnect(callback: () => void) { this.emitter.on("disconnect", callback); return () => this.emitter.off("disconnect", callback); }
  disconnect() { this.cache.clear(); this.available = false; this.emitter.emit("disconnect"); }
}

// Heartbeats only write to the open socket. No SQL queries run in idle streams.
export function menuStream(request: Request, response: Response, events: MenuEvents, venueId: string, state: () => Promise<unknown>) {
  if (!events.available) { response.status(503).end(); return; }
  response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
  response.flushHeaders();
  let closed = false, busy = false, dirty = false, debounce: NodeJS.Timeout | undefined;
  const send = async () => {
    if (closed) return;
    if (busy) { dirty = true; return; }
    busy = true;
    try {
      const data = await state();
      if (!closed) {
        const writable = response.write(`data: ${JSON.stringify(data)}\n\n`);
        if (!writable || (data as { revoked?: boolean })?.revoked) response.end();
      }
    } catch {
      if (!closed) { response.write('event: unavailable\ndata: {}\n\n'); response.end(); }
    } finally { busy = false; if (dirty && !closed) { dirty = false; schedule(); } }
  };
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => { void send(); }, 100); };
  const unsubscribe = events.subscribe(venueId, schedule);
  const offDisconnect = events.onDisconnect(() => response.end());
  const heartbeat = setInterval(() => { if (!response.write(": keep-alive\n\n")) response.end(); }, 25000);
  // Bounds legacy XHR responseText memory and periodically revalidates sessions.
  const lifetime = setTimeout(() => response.end(), 30 * 60_000);
  response.on("close", () => { closed = true; clearTimeout(debounce); clearInterval(heartbeat); clearTimeout(lifetime); unsubscribe(); offDisconnect(); });
  void send();
}
