/**
 * Person names (Section 15): one full name, optional given and family names, and a preferred name.
 * The full name is shown as the person wrote it; nothing splits it or assumes a first-last order.
 * Given and family names, when the person gives them, serve formal address and sorting, in the
 * order the viewer's language writes them.
 */

export interface PersonName {
  readonly fullName?: string | null;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly preferredName?: string | null;
}

/** Languages that write the family name first (Chinese, Japanese, Korean, Vietnamese, Hungarian, Mongolian). */
const FAMILY_FIRST = new Set(["zh", "ja", "ko", "vi", "hu", "mn"]);

/** Han, kana and hangul: names in these scripts are written without a space between the parts. */
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

function language(locale: string): string {
  try {
    return new Intl.Locale(locale).language;
  } catch {
    return locale.split("-")[0]?.toLowerCase() ?? "";
  }
}

/** True when the locale's language writes the family name before the given name. */
export function familyNameFirst(locale: string): boolean {
  return FAMILY_FIRST.has(language(locale));
}

/** Given and family names joined in the locale's order, or null when the person gave neither. */
export function composedName(name: PersonName, locale: string): string | null {
  const given = clean(name.givenName);
  const family = clean(name.familyName);
  if (!given && !family) return null;
  if (!given || !family) return given ?? family;
  const parts = familyNameFirst(locale) ? [family, given] : [given, family];
  return parts.every((p) => CJK.test(p)) ? parts.join("") : parts.join(" ");
}

/** The name to show for a person: the full name as written, else the composed or preferred name. */
export function displayName(name: PersonName, locale: string): string {
  return clean(name.fullName) ?? composedName(name, locale) ?? clean(name.preferredName) ?? "";
}

/** Formal address: given and family names in the locale's order when known, else the full name. */
export function formalName(name: PersonName, locale: string): string {
  return composedName(name, locale) ?? displayName(name, locale);
}

/** What to call the person: their preferred name, else their given name, else the full name. */
export function shortName(name: PersonName, locale: string): string {
  return clean(name.preferredName) ?? clean(name.givenName) ?? displayName(name, locale);
}

/** Sort key: the family name first when the person gave one, else the full name as written. */
export function nameSortKey(name: PersonName, locale: string): string {
  const family = clean(name.familyName);
  const key = family
    ? [family, clean(name.givenName) ?? ""].join(" ").trim()
    : displayName(name, locale);
  return key.toLocaleLowerCase(locale);
}

/** Compares two people for a list in the viewer's language (family name first when known). */
export function compareNames(a: PersonName, b: PersonName, locale: string): number {
  return new Intl.Collator(locale, { sensitivity: "base" }).compare(
    nameSortKey(a, locale),
    nameSortKey(b, locale),
  );
}
