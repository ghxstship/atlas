import type { SignedOutApprovalResult } from "@/lib/actions/one-tap";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The problem line of the signed-out approval page, or null when there is none. A decided request, a sent code and a
 * shown request are not problems, so they look up no message: there is no `outcome.decided` key, and looking one up
 * would log MISSING_MESSAGE on every successful decision. A refusal reads its gateway.outcomes key.
 */
export function signedOutApprovalProblem(
  result: SignedOutApprovalResult | null,
  t: Translate,
  to: Translate,
): string | null {
  if (
    result === null ||
    result.outcome === "ok" ||
    result.outcome === "code_sent" ||
    result.outcome === "decided"
  )
    return null;
  if (result.outcome === "refused") return to(result.refusal ?? "unexpected");
  return t(`outcome.${result.outcome}`, { attemptsLeft: result.attemptsLeft ?? 0 });
}
