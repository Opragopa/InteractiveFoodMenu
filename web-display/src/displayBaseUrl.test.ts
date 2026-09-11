import { describe, expect, it } from "vitest";
import { resolveDisplayBaseUrl } from "./displayBaseUrl";

const localBrowser = { hostname: "127.0.0.1", origin: "http://127.0.0.1:5000", port: "5000", protocol: "http:" } as Location;

describe("resolveDisplayBaseUrl", () => {
  it("uses the LAN emulator host with the current hosting port", () => {
    expect(resolveDisplayBaseUrl({ useEmulators: true, emulatorHost: "192.168.0.183", location: localBrowser }))
      .toBe("http://192.168.0.183:5000");
  });

  it("uses an explicit address before emulator settings", () => {
    expect(resolveDisplayBaseUrl({ configuredBaseUrl: "https://menu.example.com/", useEmulators: true, emulatorHost: "192.168.0.183", location: localBrowser }))
      .toBe("https://menu.example.com");
  });

  it("keeps the browser origin in production", () => {
    expect(resolveDisplayBaseUrl({ useEmulators: false, location: { hostname: "interactivefoodmenu.web.app", origin: "https://interactivefoodmenu.web.app", port: "", protocol: "https:" } }))
      .toBe("https://interactivefoodmenu.web.app");
  });

  it("does not create a QR code that another device would resolve to itself", () => {
    expect(() => resolveDisplayBaseUrl({ useEmulators: true, emulatorHost: "127.0.0.1", location: localBrowser })).toThrow(/локальной сети/);
  });
});
