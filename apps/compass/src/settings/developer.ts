/**
 * Settings, Developer in Compass (Section 4.5.6 personal item 15, A86, migration 1432, ADR 0072): the person's
 * personal API tokens in every org, with their standing, and revoke, through the @xos/data functions Gateway uses.
 * Revoking stops scripts at once, so it needs the server's answer and is disabled offline; the list shows from the
 * device.
 *
 * Creating a token stays in Gateway. The secret is shown once and is meant for a script on a computer, so it is made
 * on the computer that will hold it rather than copied off a phone, and issuing it needs a second factor passed in the
 * last 15 minutes (A77, 1333) with the org's capability groups to choose from. Compass links to Gateway's Developer
 * section and says so.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "@xos/data/client";
import { listOrgsAllowingPersonalTokens, listPersonalTokens } from "@xos/data/developer";
import type { DataError } from "@xos/data/result";
import type { Row } from "@xos/sync";

/** The device-local copy of the person's tokens. */
export const PERSONAL_TOKENS_MIRROR = "_me_personal_tokens";

/** A token as the device keeps it: its name, org, prefix and dates, never the secret (only its hash exists). */
export interface TokenRow extends Row {
  readonly orgId: string;
  readonly orgName: string | null;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/** The person's own tokens in every org, newest first, or null when the read failed. */
export async function readMyTokens(
  client: SupabaseClient,
  personId: string,
): Promise<TokenRow[] | null> {
  const result = await listPersonalTokens(client as unknown as XosClient, { personId });
  if (!result.ok) return null;
  return result.data.map((tok) => ({
    id: tok.id,
    orgId: tok.orgId,
    orgName: tok.orgName,
    name: tok.name,
    prefix: tok.prefix,
    scopes: [...tok.scopes],
    expiresAt: tok.expiresAt,
    lastUsedAt: tok.lastUsedAt,
    revokedAt: tok.revokedAt,
  }));
}

/** Whether any of the person's orgs lets them create a token (my_orgs_allowing_personal_tokens); null when unknown. */
export async function readTokensAllowed(client: SupabaseClient): Promise<boolean | null> {
  const result = await listOrgsAllowingPersonalTokens(client as unknown as XosClient);
  return result.ok ? result.data.length > 0 : null;
}

export type TokenStanding = "active" | "expired" | "revoked";

/** A token's standing, as Gateway tags it: revoked first, then expired by its date, else active. */
export function tokenStanding(token: TokenRow, nowMs: number): TokenStanding {
  if (token.revokedAt) return "revoked";
  return Date.parse(token.expiresAt) <= nowMs ? "expired" : "active";
}

/** The tag tone of each standing. */
export const STANDING_TONE: Readonly<Record<TokenStanding, "success" | "warning" | "danger">> = {
  active: "success",
  expired: "warning",
  revoked: "danger",
};

/** The tokens newest first (the order the server returns), with only a token still working offered for revoke. */
export function tokenItems(
  tokens: readonly TokenRow[],
  nowMs: number,
): { readonly token: TokenRow; readonly standing: TokenStanding; readonly revocable: boolean }[] {
  return tokens.map((token) => {
    const standing = tokenStanding(token, nowMs);
    return { token, standing, revocable: token.revokedAt === null };
  });
}

/**
 * The outcome of a revoke: a token revoked elsewhere meanwhile (personal_token_revoked) is the outcome the person
 * wanted, so it reads as done; a token gone reads as not available; anything else as a failure to try again.
 */
export function revokeOutcome(error: DataError): "done" | "gone" | "failed" {
  if (error.kind === "refusal" && error.rule === "personal_token_revoked") return "done";
  if (error.kind === "not-found") return "gone";
  return "failed";
}

/** Gateway's Developer section, where a token is created. */
export function createTokenUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/settings/developer`;
}
