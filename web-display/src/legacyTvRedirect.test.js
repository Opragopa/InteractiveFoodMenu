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
  it("keeps the Appwrite hash display on Samsung Tizen 5 TVs", () => {
    expect(redirectFor("Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) Chrome/63.0 TV Safari/537.36"))
      .toBe("");
  });

  it("opens the no-SDK pairing page for Samsung Tizen 5 TVs", () => {
    expect(redirectFor("Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) Chrome/63.0 TV Safari/537.36", "", "/connect"))
      .toBe("/connect-legacy.html");
  });

  it("keeps the normal React display on newer Samsung TVs", () => {
    expect(redirectFor("Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) Chrome/108.0 TV Safari/537.36"))
      .toBe("");
  });

  it("keeps the Appwrite hash display on webOS TVs", () => {
    expect(redirectFor("Mozilla/5.0 (Web0S; Linux) AppleWebKit/537.36 TV Safari/537.36"))
      .toBe("");
  });

  it("normalizes old Firebase display links to the Appwrite hash route", () => {
    expect(redirectFor("Mozilla/5.0 (TV; old WebKit)", "", "/display/pairingtoken123.abcdEFGH0123456789abcdEFGH0123456789"))
      .toBe("/#pairingtoken123.abcdEFGH0123456789abcdEFGH0123456789");
  });

  it("does not redirect malformed or ordinary browser URLs", () => {
    expect(redirectFor("Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0)", "#not-a-display-token"))
      .toBe("");
    expect(redirectFor("Mozilla/5.0 Chrome/136.0 Safari/537.36"))
      .toBe("");
  });

  it("does not treat the phone pairing route as a display link", () => {
    let destination = "";
    const fakeWindow = { fetch: function () {}, location: { pathname: "/pair", hash: displayHash, replace: (url) => { destination = url; } } };
    new Function("navigator", "window", script)({ userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0)" }, fakeWindow);
    expect(destination).toBe("");
  });

  it("uses the static pairing page when an old browser has no fetch", () => {
    let destination = "";
    const fakeWindow = { location: { pathname: "/connect", hash: "", replace: (url) => { destination = url; } } };
    new Function("navigator", "window", script)({ userAgent: "Mozilla/5.0 (TV; old WebKit)" }, fakeWindow);
    expect(destination).toBe("/connect-legacy.html");
  });
});
