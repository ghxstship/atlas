import { OBJECTIONABLE_TERMS, type ObjectionableTerm } from "./objectionable-terms.ts";

/**
 * The objectionable language filter (App Store Review Guideline 1.2, Google Play's user-generated content policy),
 * imported as `@xos/data/content-filter`. The database is the guard: migration 6195 refuses a post, comment, message,
 * shout-out, rating, thread subject, listing or profile text that holds a listed term, with the refusal
 * content_objectionable, and never changes what a person wrote. This module runs the same check in the app, so
 * Compass can say so before it queues a message offline and the person keeps their text.
 *
 * The normal form folds what people use to slip past a list: case, accents, and the digits and symbols that stand
 * for letters (0 for o, 1 for i, 3 for e, 4 for a, 5 for s, 7 for t, @ for a, $ for s). Everything else that is not
 * a letter separates words. private.content_filter_normal_form in the database folds the same characters; the content
 * filter test holds the two to one set.
 */

/** The refusal rule the database raises, the catalog key under each app's refusals. */
export const CONTENT_FILTER_RULE = "content_objectionable";

/** The characters folded, and what each becomes: the arguments of the database's translate(). */
export const FOLD_FROM = "ÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇáàäâãåéèëêíìïîóòöôõúùüûñç013457@$";
export const FOLD_TO = "aaaaaaeeeeiiiiooooouuuuncaaaaaaeeeeiiiiooooouuuuncoieastas";

const FOLD = new Map<string, string>(
  Array.from(FOLD_FROM).map((c, i) => [c, Array.from(FOLD_TO)[i] ?? c]),
);

/**
 * Text in the filter's normal form: folded, lowercase a to z, every run of other characters one space, with a space
 * at each end so every word, the first and last included, sits between spaces.
 */
export function contentFilterNormalForm(text: string): string {
  const folded = Array.from(text, (c) => FOLD.get(c) ?? c)
    .join("")
    .toLowerCase();
  return ` ${folded.replace(/[^a-z]+/g, " ").trim()} `;
}

function pattern(terms: readonly ObjectionableTerm[]): RegExp | null {
  if (terms.length === 0) return null;
  return new RegExp(` (${terms.map((t) => t.term).join("|")})(?:s|es|z)? `);
}

const LISTED = pattern(OBJECTIONABLE_TERMS);

/** The first listed term a text holds, or null when it holds none. */
export function objectionableTerm(
  text: string | null | undefined,
  terms: readonly ObjectionableTerm[] = OBJECTIONABLE_TERMS,
): string | null {
  if (text === null || text === undefined || text.trim() === "") return null;
  const re = terms === OBJECTIONABLE_TERMS ? LISTED : pattern(terms);
  return re?.exec(contentFilterNormalForm(text))?.[1] ?? null;
}

/** Whether any of the texts holds a listed term. */
export function holdsObjectionableLanguage(
  ...texts: readonly (string | null | undefined)[]
): boolean {
  return texts.some((t) => objectionableTerm(t) !== null);
}
