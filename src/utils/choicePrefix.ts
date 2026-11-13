export function stripChoicePrefix(text: string): string {
  // An ASCII letter followed by a period can be an abbreviation (e.g. E. coli).
  // Periods and colons after numbers need whitespace to distinguish labels
  // from values such as 1.5 and 1:2.
  return text.replace(/^\s*(?:(?:[A-EＡ-Ｅａ-ｅa-e1-5１-５]\s*[\)\]）]|[Ａ-Ｅａ-ｅ]\s*．)\s*|(?:[1-5１-５]\s*[.．]|[A-EＡ-Ｅａ-ｅa-e1-5１-５]\s*[:：])\s+)/u, '').trim();
}
