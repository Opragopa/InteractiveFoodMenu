import { describe, expect, it } from "vitest";
import { matchingCsvItems, parseMenuCsv } from "./csv";
import type { MenuItem } from "./types";

describe("parseMenuCsv", () => {
  it("parses Russian headers, quoted fields and zero stock", () => {
    expect(parseMenuCsv("Категория;Название;Цена;Количество\nНапитки;\"Чай, мята\";150,50;0"))
      .toEqual([{ category: "Напитки", name: "Чай, мята", priceMinor: 15050, stockQuantity: 0 }]);
  });

  it("accepts English headers and a positive quantity", () => {
    expect(parseMenuCsv("category,name,price,quantity\nFood,Soup,250,12")[0]).toMatchObject({ category: "Food", stockQuantity: 12 });
  });

  it("keeps a quoted comma in a comma-delimited item name", () => {
    expect(parseMenuCsv("category,name,price,quantity\nMain,\"Potatoes, mushrooms\",275,4")[0])
      .toMatchObject({ name: "Potatoes, mushrooms", priceMinor: 27500 });
  });

  it("rejects old files without quantity and invalid quantities", () => {
    expect(() => parseMenuCsv("category,name,price\nFood,Soup,250")).toThrow("Количество");
    for (const value of ["", "-1", "1.5", "2,5", "2000000001"]) {
      expect(() => parseMenuCsv(`category;name;price;quantity\nFood;Soup;250;${value}`)).toThrow("Строка 2: количество");
    }
  });

  it("matches repeated imports by category and normalized name, including ambiguities", () => {
    const items = [
      { id: "one", categoryId: "drinks", name: "Чай  с мятой" },
      { id: "two", categoryId: "drinks", name: "чай с мятой" },
      { id: "other", categoryId: "food", name: "Чай с мятой" },
    ] as MenuItem[];
    expect(matchingCsvItems(items, "drinks", "  ЧАЙ   С МЯТОЙ ").map(item => item.id)).toEqual(["one", "two"]);
    expect(matchingCsvItems(items, "food", "Чай с мятой").map(item => item.id)).toEqual(["other"]);
  });
});
