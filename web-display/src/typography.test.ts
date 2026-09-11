import { describe, expect, it } from "vitest";
import { formatRussianText } from "./typography";

describe("formatRussianText", () => {
  it("keeps short Russian prepositions and conjunctions with the following word", () => {
    expect(formatRussianText("Треска с томатами и сыром для детей"))
      .toBe("Треска с\u00A0томатами и\u00A0сыром для\u00A0детей");
  });

  it("does not alter ordinary words", () => {
    expect(formatRussianText("Картофельное пюре")).toBe("Картофельное пюре");
  });
});
