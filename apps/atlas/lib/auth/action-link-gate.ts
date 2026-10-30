import type { OrgAuthDecision } from "@xos/data/auth-assurance";
import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Viewer } from "@/lib/shell/context";
import { resolveMembership } from "@/lib/shell/membership";
import { NETWORK_RESTRICTED_PATH, orgAuthRedirect, secondFactorRedirect } from "./assurance";

/**
 * The org's security settings on a one-tap email link (A127, ADR 0106). /auth/act/{token} is not under /{org}, so
 * the proxy never resolves a membership for it; the confirm page and its button resolve one here, in the org the
 * link's notification came from, so the link meets the same rules as the Inbox: the org's IP allow-list (migration
 * 1201), and its MFA policy, session lifetime and idle timeout (migration 1330).
 */

export type ActionLinkGate =
  | { readonly kind: "member" }
  | { readonly kind: "not-member" }
  | { readonly kind: "second-factor" }
  | { readonly kind: "restricted" }
  | { readonly kind: "owed"; readonly decision: OrgAuthDecision };

/** The confirm page's own path, where verifying or signing in again returns. */
export function actionLinkPath(token: string): string {
  return `/auth/act/${token}`;
}

/** Where a gate sends the person before the link may act, or null to let it through. */
export function actionLinkGateRedirect(
  gate: ActionLinkGate,
  org: string,
  token: string,
): string | null {
  const here = actionLinkPath(token);
  if (gate.kind === "second-factor") return secondFactorRedirect(here, "");
  if (gate.kind === "restricted")
    return `${NETWORK_RESTRICTED_PATH}?org=${encodeURIComponent(org)}`;
  if (gate.kind === "owed") return orgAuthRedirect(gate.decision, org, here, "");
  return null;
}

/** The viewer's standing in the link's org under its security settings. */
export async function actionLinkGate(viewer: Viewer, org: string): Promise<ActionLinkGate> {
  if (viewer.secondFactorOwed) return { kind: "second-factor" };
  if (!viewer.person) return { kind: "not-member" };
  const outcome: { gate: ActionLinkGate | null } = { gate: null };
  const membership = await resolveMembership(
    viewer.db,
    viewer.person.id,
    org,
    await headers(),
    () => {
      outcome.gate = { kind: "restricted" };
    },
    {
      onRequired: (decision) => {
        outcome.gate = { kind: "owed", decision };
      },
    },
  );
  if (membership) return { kind: "member" };
  return outcome.gate ?? { kind: "not-member" };
}

/**
 * Applies the gate: redirects to verify, sign in again or the network notice as the proxy would for /{org}/inbox,
 * and otherwise says whether the viewer is a member there. Every link Atlas confirms is a member's (audience Atlas),
 * so it acts only for a member; an external party's or an applicant's link is Gateway's.
 */
export async function enforceActionLinkGate(
  viewer: Viewer,
  org: string,
  token: string,
): Promise<boolean> {
  const gate = await actionLinkGate(viewer, org);
  const to = actionLinkGateRedirect(gate, org, token);
  if (to !== null) redirect(to as Route);
  return gate.kind === "member";
}
