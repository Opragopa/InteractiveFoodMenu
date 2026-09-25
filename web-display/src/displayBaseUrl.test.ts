import { describe, expect, it } from "vitest";
import { resolveDisplayBaseUrl } from "./displayBaseUrl";

const localBrowser = { hostname: "127.0.0.1", origin: "http://127.0.0.1:5000", port: "5000", protocol: "http:" } as Location;

describe("resolveDisplayBaseUrl", () => {
  it("uses an explicit public address", () => {
    expect(resolveDisplayBaseUrl({ configuredBaseUrl: "https://menu.example.com/", location: localBrowser }))
      .toBe("https://menu.example.com");
  });

  it("keeps the browser origin in production", () => {
    expect(resolveDisplayBaseUrl({ location: { hostname: "menu.example.com", origin: "https://menu.example.com", port: "", protocol: "https:" } }))
      .toBe("https://menu.example.com");
  });

  it("does not create a QR code that another device would resolve to itself", () => {
    expect(() => resolveDisplayBaseUrl({ location: localBrowser })).toThrow(/локальной сети/);
  });
});
