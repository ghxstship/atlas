/**
 * The do-not-translate list (translation/terms.json): product names, canon codes, plan names,
 * identifiers, URLs and email addresses. Matches are masked before text goes to Google and must
 * still be present, unchanged, in every target string.
 */

export interface PatternSpec {
  readonly pattern: string;
  readonly flags?: string;
}

export interface DoNotTranslateTerm {
  readonly term: string;
  /** Keys (catalog keys or surface/file ids) where the word is ordinary language, not the name. */
  readonly except?: readonly string[];
  /** When set, the term is protected only in these keys (a word that is a name only there). */
  readonly only?: readonly string[];
}

export interface DoNotTranslatePattern extends PatternSpec {
  readonly name: string;
  /** False: masked for Google, but a person may localize it (example email addresses). */
  readonly check?: boolean;
}

export interface DoNotTranslate {
  readonly terms: readonly DoNotTranslateTerm[];
  readonly patterns: readonly DoNotTranslatePattern[];
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

interface Matcher {
  readonly regex: RegExp;
  /** A term's own text: the regex cannot match a string that does not contain it. */
  readonly literal: string | null;
  readonly except: ReadonlySet<string>;
  readonly only: ReadonlySet<string> | null;
  readonly check: boolean;
}

export interface Protector {
  /** Ranges of `text` that must not be translated, merged and sorted. */
  ranges(text: string, key: string): Range[];
  /** The protected words of `text` that a target must keep (patterns marked check: false left out). */
  required(text: string, key: string): string[];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole word: no letter, digit or underscore on either side. */
export function wholeWord(literal: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(literal)}(?![\\p{L}\\p{N}_])`, "gu");
}

export function compileProtector(dnt: DoNotTranslate): Protector {
  const matchers: Matcher[] = [
    ...dnt.terms.map((t) => ({
      regex: wholeWord(t.term),
      literal: t.term,
      except: new Set(t.except ?? []),
      only: t.only ? new Set(t.only) : null,
      check: true,
    })),
    ...dnt.patterns.map((p) => ({
      regex: new RegExp(p.pattern, `${(p.flags ?? "").replace(/g/g, "")}gu`),
      literal: null,
      except: new Set<string>(),
      only: null,
      check: p.check !== false,
    })),
  ];

  function matches(text: string, key: string, onlyChecked: boolean): Range[] {
    const found: Range[] = [];
    for (const m of matchers) {
      if (m.except.has(key) || (m.only !== null && !m.only.has(key)) || (onlyChecked && !m.check))
        continue;
      // Most strings hold none of the terms. A substring test is far cheaper than the whole-word
      // regex with its Unicode lookarounds, which made masking every catalog string take seconds.
      if (m.literal !== null && !text.includes(m.literal)) continue;
      m.regex.lastIndex = 0;
      for (const hit of text.matchAll(m.regex)) {
        if (hit[0] !== "") found.push({ start: hit.index, end: hit.index + hit[0].length });
      }
    }
    return found;
  }

  return {
    ranges(text, key) {
      const sorted = matches(text, key, false).sort((a, b) => a.start - b.start || b.end - a.end);
      const merged: Range[] = [];
      for (const r of sorted) {
        const prev = merged[merged.length - 1];
        if (prev && r.start <= prev.end)
          merged[merged.length - 1] = { start: prev.start, end: Math.max(prev.end, r.end) };
        else merged.push(r);
      }
      return merged;
    },
    required(text, key) {
      return [...new Set(matches(text, key, true).map((r) => text.slice(r.start, r.end)))].sort();
    },
  };
}

/** True when `word` appears in `text` as a whole word. */
export function containsWord(text: string, word: string): boolean {
  return wholeWord(word).test(text);
}
