/**
 * Which sentence explains a refusal rule in the kit's feedback (ADR 0008): the module's own copy
 * when its catalog names the rule, else the family every module shares (lifecycle moves, separation
 * of duties, spend authority, approval policies), else the generic refusal. Only that last case
 * shows the rule code, as a reference to quote; a named sentence never repeats it (crawl 4.9: PO
 * refusals printed `sod_po_creator` and `approval_policy_pending` under their sentences).
 */
export type RefusalCopy =
  | { readonly from: "module"; readonly key: string; readonly showRule: false }
  | { readonly from: "kit"; readonly key: string; readonly showRule: boolean };

export function refusalFamily(rule: string): string {
  if (rule.endsWith("_transition_not_allowed")) return "transition";
  if (rule.endsWith("_state_conflict")) return "conflict";
  if (rule.startsWith("sod_")) return "separation";
  if (rule.startsWith("spend_")) return "spend";
  if (rule === "approval_policy_pending") return "approval";
  return "other";
}

export function refusalCopy(rule: string, moduleHas: (key: string) => boolean): RefusalCopy {
  if (moduleHas(rule)) return { from: "module", key: rule, showRule: false };
  const family = refusalFamily(rule);
  return { from: "kit", key: `refusalFamily.${family}`, showRule: family === "other" };
}
