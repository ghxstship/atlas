type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has?: (key: string) => boolean;
};

/**
 * A refusal's sentence from projects.outsideAccess.errors. A rule with no sentence of its own still names its code, so a
 * refusal raised by a rule further down (an engagement's compliance trigger, say) is never read as a failed request.
 */
export function refusalText(errors: Translate, rule: string): string {
  return errors.has?.(rule) === false ? errors("refusedRule", { rule }) : errors(rule);
}
