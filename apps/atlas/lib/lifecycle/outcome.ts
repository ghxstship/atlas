/**
 * The cookie that carries a refused ownership answer from the banner's plain forms back to the banner (A79):
 * `<transfer id>:<rule>`, scoped to the org's path, for two minutes.
 */
export const OWNERSHIP_OUTCOME_COOKIE = "xos-ownership-outcome";

/** The rule a refused answer to this offer left, or null. */
export function ownershipRefusal(
  cookie: string | null | undefined,
  transferId: string,
): string | null {
  if (!cookie?.startsWith(`${transferId}:`)) return null;
  const rule = cookie.slice(transferId.length + 1);
  return /^[a-z][a-z0-9_]*$/.test(rule) ? rule : null;
}
