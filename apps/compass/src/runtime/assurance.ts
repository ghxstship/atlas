/**
 * The second factor in Compass (Section 9, A77). Compass uses the same sign-in as Atlas and Gateway, so a person
 * who set up an authenticator app there verifies it here after the first factor, and an org whose security
 * settings require a second factor for the person's role, or whose session lifetime has run out, holds the device
 * until that is done. Setting up a factor happens in Atlas or Gateway (Settings, Security).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ChallengeFactor {
  readonly id: string;
  readonly label: string;
}

export type SecondFactorGate =
  | { readonly kind: "ok" }
  | { readonly kind: "verify"; readonly factors: readonly ChallengeFactor[] }
  | { readonly kind: "enroll-elsewhere" }
  | { readonly kind: "sign-in-again" };

interface OrgAuthRow {
  readonly mfa_required?: boolean;
  readonly mfa_verified?: boolean;
  readonly session_expired?: boolean;
}

/**
 * What the session owes before Compass opens: with `orgId`, also what that org's security settings ask
 * (`app.my_org_auth_status`, migration 1330): a second factor security.mfa_policy asks of the person's roles, and
 * signing in again once security.session_hours has passed. Authenticator apps are the second factor Compass can
 * verify.
 */
export async function secondFactorGate(
  client: SupabaseClient,
  orgId: string | null,
): Promise<SecondFactorGate> {
  // Both read the stored session, so the check needs no network of its own.
  const [levels, current] = await Promise.all([
    client.auth.mfa.getAuthenticatorAssuranceLevel(),
    client.auth.getSession(),
  ]);
  if (levels.error) throw levels.error;
  const totp = (current.data.session?.user.factors ?? [])
    .filter((f) => f.factor_type === "totp" && f.status === "verified")
    .map((f) => ({ id: f.id, label: f.friendly_name ?? "" }));
  const aal2 = levels.data.currentLevel === "aal2";
  if (!aal2 && levels.data.nextLevel === "aal2" && totp.length > 0) {
    return { kind: "verify", factors: totp };
  }
  if (orgId === null) return { kind: "ok" };
  const { data, error } = await client.rpc("my_org_auth_status", { p_org_id: orgId });
  if (error) throw error;
  const row = ((data ?? []) as OrgAuthRow[])[0];
  if (row?.session_expired === true) return { kind: "sign-in-again" };
  if (row?.mfa_required === true && row.mfa_verified !== true) {
    return totp.length > 0 ? { kind: "verify", factors: totp } : { kind: "enroll-elsewhere" };
  }
  return { kind: "ok" };
}

/** Verifies a code from the authenticator app; the session becomes aal2 and the auth listener sees it. */
export async function verifySecondFactor(
  client: SupabaseClient,
  factorId: string,
  code: string,
): Promise<"ok" | "invalid" | "network"> {
  const { error } = await client.auth.mfa.challengeAndVerify({
    factorId,
    code: code.replace(/\s/g, ""),
  });
  if (!error) return "ok";
  if (error.status === 0 || /fetch|network/i.test(error.message)) return "network";
  return "invalid";
}
