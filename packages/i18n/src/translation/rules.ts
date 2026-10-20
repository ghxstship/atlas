/**
 * Terminology: the checked rules of translation/terms.json (for example, a project gate is a
 * "compuerta" in es-US) and the glossary terms that decide when review keeps a person's wording.
 */
import { regex, type Glossary, type TermRule, type Terms } from "./config.ts";
import { wholeWord } from "./protect.ts";

export interface CompiledRules {
  /** Rules that apply to a key, given its en-US literal text. */
  applicable(key: string, sourceText: string): TermRule[];
  /** Problems with a target's literal text under the rules that apply to its key. */
  violations(key: string, sourceText: string, locale: string, targetText: string): string[];
  /** False when a rule that applies to the key turns the Google glossary off. */
  usesGlossary(key: string, sourceText: string): boolean;
}

export function compileRules(terms: Terms): CompiledRules {
  const byId = new Map(terms.rules.map((r) => [r.id, r]));
  const compiled = terms.rules.map((rule) => {
    const except = new Set(
      (rule.except ?? []).flatMap((e) =>
        e.startsWith("@") ? (byId.get(e.slice(1))?.keys ?? []) : [e],
      ),
    );
    return {
      rule,
      except,
      keys: new Set(rule.keys ?? []),
      source: rule.source ? regex(rule.source) : null,
    };
  });

  const applicable = (key: string, sourceText: string) =>
    compiled
      .filter(
        (c) =>
          !c.except.has(key) &&
          (c.keys.has(key) || (c.source !== null && c.source.test(sourceText))),
      )
      .map((c) => c.rule);

  return {
    applicable,
    violations(key, sourceText, locale, targetText) {
      const out: string[] = [];
      for (const rule of applicable(key, sourceText)) {
        const target = rule.targets[locale];
        if (!target) continue;
        if (target.require && !regex(target.require).test(targetText))
          out.push(`${rule.id}: needs /${target.require.pattern}/`);
        for (const f of target.forbid ?? []) {
          if (regex(f).test(targetText)) out.push(`${rule.id}: must not contain /${f.pattern}/`);
        }
      }
      return out;
    },
    usesGlossary(key, sourceText) {
      return applicable(key, sourceText).every((r) => r.googleGlossary !== false);
    },
  };
}

/**
 * The glossary's rendering of a domain term that the current target uses and Google's version does
 * not, for a term that appears in the source. Review keeps the current wording in that case.
 */
export function keptDomainTerm(
  glossary: Glossary,
  sourceLanguage: string,
  targetLanguage: string,
  source: string,
  current: string,
  fresh: string,
): string | null {
  const lower = (s: string) => s.toLocaleLowerCase();
  for (const row of glossary.rows) {
    const en = row[sourceLanguage] ?? "";
    const term = row[targetLanguage] ?? "";
    if (en === "" || term === "" || lower(en) === lower(term)) continue;
    if (!wholeWord(lower(en)).test(lower(source))) continue;
    if (wholeWord(lower(term)).test(lower(current)) && !wholeWord(lower(term)).test(lower(fresh)))
      return term;
  }
  return null;
}
