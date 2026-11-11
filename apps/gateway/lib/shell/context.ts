import {
  getCurrentPerson,
  listMyAccounts,
  listMyEngagementRoleTypes,
  type Engagement,
  type ExternalAccount,
  type XosClient,
} from "@xos/data/gateway";
import { tokenAal } from "@xos/data/auth-assurance";
import { listOrgsAllowingPersonalTokens } from "@xos/data/developer";
import { ROLE_LENS_COOKIE } from "@xos/data/role-lens";
import type { NavContext } from "@xos/ia";
import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { secondFactorRedirect } from "@/lib/auth/assurance";
import { resolveBrand, type GatewayBrand } from "@/lib/brand/brand";
import { env, platformHosts } from "@/lib/env";
import { doesPaidWork } from "@/lib/engagement-state";
import { createServerSupabase } from "@/lib/supabase/server";
import { lensRoleTypes, resolveGatewayLens, type GatewayLens } from "./role-lens";
import {
  ACTING_COOKIE,
  isDesktopAgent,
  isPlatformHost,
  navContext,
  resolveActing,
  type Standing,
} from "./standing";

/**
 * The Gateway request context, read once per request: the signed-in person, their external
 * accounts, the account this device acts for, their standing, the role lens (A128), the sitemap navigation
 * context and the brand of the host. Pages and the shell read it; the proxy guards routes with the same rules.
 */
export interface GatewayContext {
  readonly db: XosClient;
  readonly userId: string;
  readonly email: string | null;
  readonly personId: string;
  readonly personName: string | null;
  readonly accounts: readonly ExternalAccount[];
  readonly acting: ExternalAccount | null;
  readonly standing: Standing;
  /** The role lens: All roles, or one role type of the person's engagements (Section 4.8.1). */
  readonly lens: GatewayLens;
  readonly nav: NavContext;
  /** Navigation for every role type, which the page guard follows as the proxy does, whatever the lens. */
  readonly ownNav: NavContext;
  readonly platformDomain: boolean;
  readonly brand: GatewayBrand;
}

export interface RequestFacts {
  readonly host: string | null;
  readonly platformDomain: boolean;
  readonly desktop: boolean;
  readonly brand: GatewayBrand;
}

/** Host, domain kind, device class and brand of this request; needs no session. */
export const getRequestFacts = cache(async (): Promise<RequestFacts> => {
  const headerStore = await headers();
  const host = headerStore.get("host");
  const platformDomain = isPlatformHost(host, platformHosts(env()));
  return {
    host,
    platformDomain,
    desktop: isDesktopAgent(headerStore.get("user-agent")),
    brand: await resolveBrand(await createServerSupabase(), host, platformDomain),
  };
});

/**
 * The request's Supabase client and signed-in user, read once per request, with no second-factor check: locale
 * negotiation reads the person's language through it on every page, the second-factor page among them, where
 * getGatewayContext's redirect would send the page to itself.
 */
export const getSignedInSession = cache(async () => {
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  return { db, user: data.user };
});

/** The context of a signed-in person, or null when nobody is signed in. */
export const getGatewayContext = cache(async (): Promise<GatewayContext | null> => {
  const { db, user } = await getSignedInSession();
  if (!user) return null;
  // A server action that signs in and redirects renders its target in the same request, past the proxy, so a
  // second factor the person holds is asked for here too (A77).
  if ((user.factors ?? []).some((f) => f.status === "verified")) {
    const { data: current } = await db.auth.getSession();
    if (tokenAal(current.session?.access_token) === "aal1") {
      const here = (await headers()).get("x-gateway-path") ?? "/home";
      redirect(secondFactorRedirect(here, "") as Route);
    }
  }
  const [person, accounts, roleTypes, cookieStore, facts, tokenOrgs] = await Promise.all([
    getCurrentPerson(db, user.id),
    listMyAccounts(db),
    listMyEngagementRoleTypes(db),
    cookies(),
    getRequestFacts(),
    listOrgsAllowingPersonalTokens(db),
  ]);
  if (!person.ok) {
    if (person.error.kind === "not-found") return null;
    throw new Error(`Gateway could not read the signed-in person: ${person.error.kind}`);
  }
  if (!accounts.ok) {
    throw new Error(`Gateway could not read external accounts: ${accounts.error.kind}`);
  }
  const acting = resolveActing(accounts.data, cookieStore.get(ACTING_COOKIE)?.value);
  const lens = resolveGatewayLens(
    roleTypes.ok ? roleTypes.data : [],
    cookieStore.get(ROLE_LENS_COOKIE)?.value,
  );
  const navFor = (roleTypesForNav: readonly Engagement["roleType"][] | null) =>
    navContext({
      standing: acting.standing,
      companyAccount: acting.account !== null,
      platformDomain: facts.platformDomain,
      desktop: facts.desktop,
      // A failed read keeps the paid-work pages: hiding a person's payout settings by mistake is worse.
      paidWork: roleTypesForNav === null ? true : doesPaidWork(roleTypesForNav),
      // Settings, Developer appears when an org the person belongs to allows personal tokens (A86).
      personalTokens: tokenOrgs.ok && tokenOrgs.data.length > 0,
    });
  return {
    db,
    userId: user.id,
    email: user.email ?? null,
    personId: person.data.id,
    personName: person.data.fullName,
    accounts: accounts.data,
    acting: acting.account,
    standing: acting.standing,
    lens,
    // Under a role lens only the lens's role type counts, which can hide the paid-work pages but never shows them.
    nav: navFor(roleTypes.ok ? lensRoleTypes(lens, roleTypes.data) : null),
    ownNav: navFor(roleTypes.ok ? roleTypes.data : null),
    platformDomain: facts.platformDomain,
    brand: facts.brand,
  };
});

/** The context, sending signed-out visitors to sign in and back here afterwards. */
export async function requireContext(next: string): Promise<GatewayContext> {
  const ctx = await getGatewayContext();
  if (!ctx) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  return ctx;
}

/** 404 unless the condition holds (ADR 0017 item 3: hidden answers 404, never 403). */
export function orNotFound<T>(value: T | null | undefined | false): T {
  if (value === null || value === undefined || value === false) notFound();
  return value;
}
