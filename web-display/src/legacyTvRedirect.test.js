import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("index.html", "utf8");
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("Legacy TV redirect bootstrap is missing from index.html");
const displayHash = "#pairingtoken123.abcdEFGH0123456789abcdEFGH0123456789";

function redirectFor(userAgent, hash = displayHash, pathname = "/") {
  let destination = "";
  const fakeWindow = { fetch: function () {}, location: { pathname, hash, replace: (url) => { destination = url; } } };
  new Function("navigator", "window", script)({ userAgent }, fakeWindow);
  return destination;
}

describe("legacy TV display fallback", () => {
  it("routes Samsung Tizen 5 displays to server HTML", () => {
    expect(redirectFor("Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) Chrome/63.0 TV Safari/537.36"))
      .toBe("/tv/activate" + displayHash);
  });

  it("opens server pairing for Samsung Tizen 5 TVs", () => {
    expect(redirectFor("Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) Chrome/63.0 TV Safari/537.36", "", "/connect"))
      .toBe("/tv/connect");
  });

  it("keeps the normal React display on newer Samsung TVs", () => {
    expect(redirectFor("Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) Chrome/108.0 TV Safari/537.36"))
      .toBe("");
  });

  it("routes webOS displays to server HTML", () => {
    expect(redirectFor("Mozilla/5.0 (Web0S; Linux) AppleWebKit/537.36 TV Safari/537.36"))
      .toBe("/tv/activate" + displayHash);
  });

  it("accepts old path credentials on server HTML", () => {
    expect(redirectFor("Mozilla/5.0 (Web0S; Linux) Chrome/38.0", "", "/display/pairingtoken123.abcdEFGH0123456789abcdEFGH0123456789"))
      .toBe("/tv/activate#pairingtoken123.abcdEFGH0123456789abcdEFGH0123456789");
  });

  it("opens pairing for a malformed old-TV link and leaves ordinary browsers alone", () => {
    expect(redirectFor("Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0)", "#not-a-display-token"))
      .toBe("/tv/connect");
    expect(redirectFor("Mozilla/5.0 Chrome/136.0 Safari/537.36"))
      .toBe("");
  });

  it("does not treat the phone pairing route as a display link", () => {
    let destination = "";
    const fakeWindow = { fetch: function () {}, location: { pathname: "/pair", hash: displayHash, replace: (url) => { destination = url; } } };
    new Function("navigator", "window", script)({ userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0)" }, fakeWindow);
    expect(destination).toBe("");
  });

  it("uses server pairing when an old browser has no fetch", () => {
    let destination = "";
    const fakeWindow = { location: { pathname: "/connect", hash: "", replace: (url) => { destination = url; } } };
    new Function("navigator", "window", script)({ userAgent: "Mozilla/5.0 (TV; old WebKit)" }, fakeWindow);
    expect(destination).toBe("/tv/connect");
  });
});

// Nginx preserves the fragment when redirecting / to /connect.
it.each(["Mozilla/5.0 (Web0S; Linux) Chrome/38.0", "Mozilla/5.0 (SMART-TV; Tizen 5.0) Chrome/63.0", "Chrome/136.0"])("preserves display credentials after the root redirect: %s", userAgent => {
  const expected = userAgent === "Chrome/136.0" ? "" : "/tv/activate" + displayHash;
  expect(redirectFor(userAgent, displayHash, "/connect")).toBe(expected);
  expect(redirectFor(userAgent, displayHash, "/connect/")).toBe(expected);
});
it("routes Chromium 38 connect with a fetch polyfill to server pairing", () => {
  expect(redirectFor("Chrome/38.0", "", "/connect/")).toBe("/tv/connect");
});
