/** Keeps Russian short function words from being left alone at the end of a line. */
export function formatRussianText(value: string): string {
  return value.replace(
    /(^|\s)([а-яё]|не|ни|по|на|за|из|до|от|со|во|об|обо|для|без|над|под|при|про|или|либо)\s+/gi,
    (_, prefix: string, word: string) => `${prefix}${word}\u00A0`,
  );
}
