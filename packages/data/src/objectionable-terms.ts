/**
 * The objectionable language filter's term list (App Store Review Guideline 1.2, Google Play's user-generated content
 * policy): slurs that are refused wherever a person writes text other people read. The database refuses them
 * (private.objectionable_terms, migration 6890 and every later sync) and Compass checks the same list before it queues
 * a message, so a person keeps what they wrote and reads why at once.
 *
 * To change the list: edit it here, then write a migration that loads it with
 *   pnpm --filter @xos/data content-filter:migration <number>_objectionable_terms
 * The content filter test fails while the newest migration that loads the list differs from this file.
 *
 * Each term is in its normal form (contentFilterNormalForm): lowercase a to z, words separated by one space. A term
 * matches a whole word or words, with an optional plural ending (s, es or z); accents and common digit and symbol
 * stand-ins are folded first.
 *
 * Only a word whose ordinary meaning in US English or Spanish is the slur belongs here. The filter refuses without a
 * person looking and nobody can override it, and it reads names too (a preferred name, a handle made from a legal name),
 * so a word that is also a given name, a nickname, a surname, a brand, a trade term or an everyday word stays off the
 * list even when it is also a slur; reports and moderators handle those. The content filter test holds such names
 * and phrases, and every one of them must pass.
 */

export interface ObjectionableTerm {
  /** The term in its normal form. */
  readonly term: string;
  /** The language it belongs to: English or Spanish, the two languages XOS ships in. */
  readonly language: "en" | "es";
}

export const OBJECTIONABLE_TERMS: readonly ObjectionableTerm[] = [
  { term: "beaner", language: "en" },
  { term: "cunt", language: "en" },
  { term: "fag", language: "en" },
  { term: "faggot", language: "en" },
  { term: "heil hitler", language: "en" },
  { term: "jigaboo", language: "en" },
  { term: "nigga", language: "en" },
  { term: "nigger", language: "en" },
  { term: "porch monkey", language: "en" },
  { term: "raghead", language: "en" },
  { term: "shemale", language: "en" },
  { term: "sieg heil", language: "en" },
  { term: "towelhead", language: "en" },
  { term: "wetback", language: "en" },
  { term: "joto", language: "es" },
  { term: "maricon", language: "es" },
  { term: "negrata", language: "es" },
  { term: "sudaca", language: "es" },
];
