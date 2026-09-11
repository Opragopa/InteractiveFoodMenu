export type CsvMenuRow = {
  category: string;
  name: string;
  priceMinor: number;
  isAvailable: boolean;
};

const categoryHeaders = new Set(["категория", "category", "раздел"]);
const nameHeaders = new Set(["название", "позиция", "блюдо", "name", "item"]);
const priceHeaders = new Set(["цена", "price", "стоимость"]);
const availabilityHeaders = new Set(["в наличии", "наличие", "available", "availability"]);

export function parseMenuCsv(content: string): CsvMenuRow[] {
  const lines = records(content.replace(/^\uFEFF/, "")).filter(line => line.trim());
  if (!lines.length) throw new Error("CSV-файл пуст.");
  const delimiter = countDelimiter(lines[0], ";") > countDelimiter(lines[0], ",") ? ";" : ",";
  const header = split(lines[0], delimiter).map(normalize);
  const categoryIndex = header.findIndex(value => categoryHeaders.has(value));
  const nameIndex = header.findIndex(value => nameHeaders.has(value));
  const priceIndex = header.findIndex(value => priceHeaders.has(value));
  const availabilityIndex = header.findIndex(value => availabilityHeaders.has(value));
  if (categoryIndex < 0 || nameIndex < 0 || priceIndex < 0) throw new Error("Нужны столбцы: Категория, Название, Цена.");

  return lines.slice(1).map((line, index) => {
    const row = split(line, delimiter);
    const field = (column: number) => (row[column] ?? "").trim();
    const category = field(categoryIndex);
    const name = field(nameIndex);
    const price = priceToMinor(field(priceIndex));
    const lineNumber = index + 2;
    if (!category || category.length > 50) throw new Error(`Строка ${lineNumber}: укажите категорию до 50 символов.`);
    if (!name || name.length > 80) throw new Error(`Строка ${lineNumber}: укажите название до 80 символов.`);
    if (price === null) throw new Error(`Строка ${lineNumber}: некорректная цена.`);
    return { category, name, priceMinor: price, isAvailable: availabilityIndex < 0 || parseAvailability(field(availabilityIndex), lineNumber) };
  });
}

function normalize(value: string) { return value.trim().toLocaleLowerCase().replace(/\s+/g, " "); }
function countDelimiter(value: string, delimiter: string) { return split(value, delimiter).length - 1; }

function priceToMinor(value: string): number | null {
  if (!/^\d+(?:[,.]\d{1,2})?$/.test(value.trim())) return null;
  const result = Math.round(Number(value.replace(",", ".")) * 100);
  return Number.isSafeInteger(result) && result >= 0 && result <= 99_999_999 ? result : null;
}

function parseAvailability(value: string, line: number): boolean {
  if (["", "да", "yes", "true", "1", "в наличии"].includes(normalize(value))) return true;
  if (["нет", "no", "false", "0", "нет в наличии"].includes(normalize(value))) return false;
  throw new Error(`Строка ${line}: значение наличия должно быть Да или Нет.`);
}

function records(content: string): string[] {
  const result: string[] = [];
  let record = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"') {
      if (quoted && content[index + 1] === '"') { record += '""'; index += 1; }
      else { quoted = !quoted; record += char; }
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && content[index + 1] === "\n") index += 1;
      result.push(record); record = "";
    } else record += char;
  }
  if (quoted) throw new Error("CSV содержит незакрытую кавычку.");
  if (record) result.push(record);
  return result;
}

function split(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { value += char; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { result.push(value); value = ""; }
    else value += char;
  }
  if (quoted) throw new Error("CSV содержит незакрытую кавычку.");
  result.push(value);
  return result;
}
