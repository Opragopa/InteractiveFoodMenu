import { describe, expect, it } from "vitest";
import { parseMenuCsv } from "./csv";

describe("parseMenuCsv", () => {
  it("parses Russian headers, quoted fields and availability", () => {
    expect(parseMenuCsv("Категория;Название;Цена;В наличии\nНапитки;\"Чай, мята\";150,50;Нет"))
      .toEqual([{ category: "Напитки", name: "Чай, мята", priceMinor: 15050, isAvailable: false }]);
  });

  it("accepts English headers and defaults availability to true", () => {
    expect(parseMenuCsv("category,name,price\nFood,Soup,250")[0]).toMatchObject({ category: "Food", isAvailable: true });
  });

  it("keeps a quoted comma in a comma-delimited item name", () => {
    expect(parseMenuCsv("category,name,price\nMain,\"Potatoes, mushrooms\",275")[0])
      .toMatchObject({ name: "Potatoes, mushrooms", priceMinor: 27500 });
  });
});
