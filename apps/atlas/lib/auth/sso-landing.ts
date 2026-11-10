import { joinBySsoSession } from "@xos/data/identity-providers";
import type { XosClient } from "@xos/data/client";

/**
 * Where a single sign-on lands (A77): the person joins the identity provider's org when it adds people just in time, and
 * goes to that org's Home unless they were going somewhere. `null` means the org's blocklist (B16, 6050) refused the join,
 * so they hear the generic sentence. It runs after the age question (ADR 0156), since the database refuses a join until
 * that is answered: from the auth callback when it was answered before, and from the question itself otherwise.
 */
export async function ssoLanding(
  db: XosClient,
  provider: unknown,
  next: string,
): Promise<string | null> {
  if (typeof provider !== "string" || !provider.startsWith("sso:")) return next;
  const joined = await joinBySsoSession(db);
  if (!joined.ok && joined.error.kind === "refusal" && joined.error.rule === "member_blocked") {
    return null;
  }
  return joined.ok && joined.data && next === "/" ? `/${joined.data.slug}/home` : next;
}
