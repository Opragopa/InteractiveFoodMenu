import { describe, expect, it } from "vitest";
import { clampBreakMinutes, remainingBreakSeconds } from "./break";

describe("break state", () => {
  it("clamps duration to one hour", () => {
    expect(clampBreakMinutes(0)).toBe(1);
    expect(clampBreakMinutes(90)).toBe(60);
    expect(clampBreakMinutes("bad")).toBe(10);
  });
  it("counts down and expires", () => {
    const end = new Date(100_000).toISOString();
    expect(remainingBreakSeconds(true, end, 40_000)).toBe(60);
    expect(remainingBreakSeconds(true, end, 101_000)).toBe(0);
    expect(remainingBreakSeconds(false, end, 40_000)).toBe(0);
  });
});
