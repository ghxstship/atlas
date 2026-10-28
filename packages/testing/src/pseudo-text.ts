/**
 * Gate 16 (Section 15): telling data from hard-coded copy under the en-XA pseudo-locale.
 *
 * en-XA wraps every catalog message in `[` … ` ·]` (packages/i18n/src/pseudo.ts), so text a person
 * sees outside a wrap did not come from a catalog. It is either data (a project name, a person, a
 * formatted date, a docs article) or a hard-coded or untranslated string. Data is told apart by
 * looking the text up in what the page reads from (the database, the docs content) and by the shapes
 * Intl formatting produces; what is left is a finding. The browser side is in pseudo.ts.
 */

/** Text found on a page. */
export interface Found {
  /** The text, trimmed and shortened. */
  readonly text: string;
  /** Where it is: a short element path, and the attribute when the text is one. */
  readonly where: string;
}

/** The text a page shows as data: database values, or the content files a docs page renders. */
export interface KnownText {
  has(text: string): boolean;
  /**
   * True when the source shows identifiers as content (the docs reference and data dictionary name
   * tables, columns and operations), so a snake_case or dotted name it holds is data. Elsewhere such
   * a name is a raw enum or event key shown instead of its label, even when the database holds it.
   */
  readonly identifiers?: boolean;
}

/** Shapes en-US Intl formatting gives data: dates, times, relative times, numbers and money. */
export const FORMATTED: readonly RegExp[] = [
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(, \d{4})?/,
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b/,
  /^\d{1,2} (Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*$/,
  /^\d+ (second|minute|hour|day|week|month|year)s? ago$/,
  /^in \d+ (second|minute|hour|day|week|month|year)s?$/,
  /^(yesterday|today|tomorrow|now|last|next) ?(week|month|year)?$/,
  /^\d{1,2}:\d{2}( ?[AP]M)?$/,
  /^[AP]M$/,
  /^[A-Z]{3}$/,
  /^[\d\s.,:/$€£¥%+\-–—()·]*(AM|PM|USD|EUR|GBP|hrs?|min|h|d|K|M|B)?[\d\s.,:/$€£¥%+\-–—()·]*$/,
];

/** Never human text even when the data holds it: an event type or enum key shown raw. */
const RAW_KEY = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/;

/** Separators code puts between data values ("NWS · Northwind Summer Series", "Lee, Jordan"). */
const SEPARATORS = /\s*(?:·|•|—|–|\||\/|,|:|›|>|\(|\)|\+)\s*|\s+-\s+/;

/** A record key (NWS-12) or a code (US-FL-MIAMI-DADE, G2.CONTRACTS), with any hyphen glyph. */
const CODE = /^[A-Z0-9]+(?:[-‐‑‒–−_.][A-Z0-9]+)*$/;

/** Whether unwrapped text is data (or formatting of data) rather than copy that missed a catalog. */
export function isData(raw: string, data: KnownText): boolean {
  // Punctuation code puts between values ("· NWS") belongs to neither side.
  const text = raw.replace(/^[\s·•.,:;|/()–—-]+|[\s·•.,:;|/()–—-]+$/g, "");
  if (!/[A-Za-z]{2,}/.test(text)) return true;
  if (RAW_KEY.test(text) && !data.identifiers) return false;
  if (data.has(raw.trim()) || data.has(text)) return true;
  if (CODE.test(text)) return true;
  if (FORMATTED.some((re) => re.test(text))) return true;
  // Emails, web addresses, paths and initials.
  if (/^\S+@\S+\.\S+$/.test(text) || /^(https?:\/\/|\/)\S*$/.test(text)) return true;
  if (/^[A-Z]{1,3}$/.test(text)) return true;
  const pieces = text.split(SEPARATORS).filter((p) => /[A-Za-z]{2,}/.test(p));
  if (
    pieces.length > 1 &&
    pieces.every(
      (p) =>
        data.has(p) || FORMATTED.some((re) => re.test(p)) || /^[A-Z]{1,3}$/.test(p) || CODE.test(p),
    )
  ) {
    return true;
  }
  return composed(text, data);
}

/** Punctuation code puts around and between values, which belongs to no value. */
const EDGES = /^[\s·•.,:;|/()+&\u2013\u2014-]+|[\s·•.,:;|/()+&\u2013\u2014-]+$/g;

/**
 * Whether text is values composed by code with spaces and punctuation between them ("NWG Northwind
 * Winter Gala", "Power 5000.06.01: House power, capacity not confirmed. (1)"): its words split into
 * runs that are each a data value, a code, a number or a formatted value. Runs may span punctuation
 * (a value that holds a "+" or a comma), so every split is tried.
 */
function composed(text: string, data: KnownText): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 60) return false;
  const known = (run: string) => {
    const bare = run.replace(EDGES, "");
    if (!/[A-Za-z]{2,}/.test(bare)) return true;
    if (RAW_KEY.test(bare) && !data.identifiers) return false;
    return (
      data.has(run) ||
      data.has(bare) ||
      CODE.test(bare) ||
      /^[A-Z]{1,3}$/.test(bare) ||
      FORMATTED.some((re) => re.test(bare))
    );
  };
  // reach[i]: the first i words split into known runs.
  const reach = [true, ...words.map(() => false)];
  for (let i = 1; i <= words.length; i += 1) {
    for (let j = i - 1; j >= 0 && !reach[i]; j -= 1) {
      reach[i] = reach[j] === true && known(words.slice(j, i).join(" "));
    }
  }
  return reach[words.length] === true;
}

/** Found text that is neither data nor formatting, each text and place once. */
export function hardCoded(found: readonly Found[], data: KnownText): Found[] {
  const seen = new Set<string>();
  return found.filter((f) => {
    if (isData(f.text, data)) return false;
    const key = `${f.text}|${f.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Text taken from long-form sources (Markdown articles, an OpenAPI document): a page shows any run
 * of it, split wherever inline markup falls, so a found run is known when it appears anywhere in the
 * sources with whitespace collapsed.
 */
export function contentText(
  sources: Iterable<string>,
  { identifiers = false }: { readonly identifiers?: boolean } = {},
): KnownText {
  const corpus = [...sources].map((s) => s.replace(/\s+/g, " ")).join("\n");
  return {
    has: (text) => text.trim() !== "" && corpus.includes(text.replace(/\s+/g, " ").trim()),
    identifiers,
  };
}

/** Known text plus values a test wrote after it was loaded (a fixture's generated title). */
export function withText(data: KnownText, values: Iterable<string>): KnownText {
  const extra = new Set([...values].map((v) => v.trim()));
  return {
    has: (text) => extra.has(text) || data.has(text),
    ...(data.identifiers === undefined ? {} : { identifiers: data.identifiers }),
  };
}

/** Every string inside a parsed JSON value, keys included (field names a reference page shows). */
export function jsonStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [k, ...jsonStrings(v)]);
  }
  return [];
}

/** One line per problem, for an assertion message that lists them all; long text is shortened. */
export function describe(found: readonly Found[]): string[] {
  return found.map((f) => `"${f.text.slice(0, 120)}" at ${f.where}`);
}
