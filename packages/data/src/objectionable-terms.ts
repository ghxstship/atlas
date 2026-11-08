/**
 * The objectionable language filter's term list (App Store Review Guideline 1.2, Google Play's user-generated content
 * policy): slurs that are refused wherever a person writes text other people read. The database refuses them
 * (private.objectionable_terms, migration 6195 and every later sync) and Compass checks the same list before it queues
 * a message, so a person keeps what they wrote and reads why at once.
 *
 * To change the list: edit it here, then write a migration that loads it with
 *   pnpm --filter @xos/data content-filter:migration <number>_objectionable_terms
 * The content filter test fails while the newest migration that loads the list differs from this file.
 *
 * Each term is in its normal form (contentFilterNormalForm): lowercase a to z, words separated by one space. A term
 * matches a whole word or words, with an optional plural ending (s, es or z); accents and common digit and symbol
 * stand-ins are folded first. Words with a common harmless meaning in workplace English or Spanish stay off the list,
 * because the filter refuses without a person looking; reports and moderators handle the rest.
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
  { term: "dyke", language: "en" },
  { term: "fag", language: "en" },
  { term: "faggot", language: "en" },
  { term: "gook", language: "en" },
  { term: "heil hitler", language: "en" },
  { term: "jigaboo", language: "en" },
  { term: "kike", language: "en" },
  { term: "nigga", language: "en" },
  { term: "nigger", language: "en" },
  { term: "paki", language: "en" },
  { term: "porch monkey", language: "en" },
  { term: "raghead", language: "en" },
  { term: "retard", language: "en" },
  { term: "shemale", language: "en" },
  { term: "sieg heil", language: "en" },
  { term: "spic", language: "en" },
  { term: "towelhead", language: "en" },
  { term: "wetback", language: "en" },
  { term: "joto", language: "es" },
  { term: "marica", language: "es" },
  { term: "maricon", language: "es" },
  { term: "mayate", language: "es" },
  { term: "negrata", language: "es" },
  { term: "sudaca", language: "es" },
];
