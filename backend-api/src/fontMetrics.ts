import { openSync, type Font } from "fontkit";
import { fileURLToPath } from "node:url";

const fonts = new Map<string, Font>();
function font(weight: "semibold" | "bold") {
  let result = fonts.get(weight);
  if (!result) {
    result = openSync(fileURLToPath(new URL(`../assets/onest-static-${weight}.ttf`, import.meta.url))) as Font;
    fonts.set(weight, result);
  }
  return result;
}

export function textWidth(value: string, pixels: number, weight: "semibold" | "bold" = "semibold") {
  const face = font(weight);
  const run = face.layout(value);
  return run.positions.reduce((total, position) => total + position.xAdvance, 0) * pixels / face.unitsPerEm;
}

export function wrappedLineCount(value: string, width: number, pixels: number) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  let lines = 1;
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, pixels) * 1.08 <= width) { current = candidate; continue; }
    if (current) { lines++; current = ""; }
    if (textWidth(word, pixels) * 1.08 <= width) { current = word; continue; }
    let segment = "";
    for (const char of word) {
      if (segment && textWidth(segment + char, pixels) * 1.08 > width) { lines++; segment = char; }
      else segment += char;
    }
    current = segment;
  }
  return lines;
}
