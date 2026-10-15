import { strongestAccountRole, type AccountRole, type ExternalAccount } from "@xos/data";
import type { Condition, NavContext } from "@xos/ia";

/**
 * A person's standing in Gateway (ADR 0006 item 6, Section 4.5.8): they act for themselves
 * (`individual`, no company account) or for one external account they belong to, with the
 * strongest account role they hold there. The sitemap's visibility keys use these names.
 */
export const STANDINGS = [
  "individual",
  "account-owner",
  "account-admin",
  "account-finance",
  "account-member",
] as const;
export type Standing = (typeof STANDINGS)[number];

const ROLE_STANDING: Readonly<Record<AccountRole, Standing>> = {
  "Account Owner": "account-owner",
  "Account Admin": "account-admin",
  "Account Finance": "account-finance",
  "Account Member": "account-member",
};

/** The cookie that remembers which account this device acts for; absent or `self` for oneself. */
export const ACTING_COOKIE = "xos-acting";

export interface Acting {
  readonly account: ExternalAccount | null;
  readonly standing: Standing;
}

/** Resolves the acting account from the cookie; an account the person left falls back to self. */
export function resolveActing(
  accounts: readonly ExternalAccount[],
  cookie: string | undefined,
): Acting {
  const account = cookie && cookie !== "self" ? accounts.find((a) => a.id === cookie) : undefined;
  const role = account ? strongestAccountRole(account.roles) : null;
  if (!account || !role) return { account: null, standing: "individual" };
  return { account, standing: ROLE_STANDING[role] };
}

/** True when the request host serves the platform Gateway rather than an org's custom domain. */
export function isPlatformHost(host: string | null, platformHosts: readonly string[]): boolean {
  if (!host) return true;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return platformHosts.includes(name);
}

/** Phones and tablets announce themselves in the user agent; everything else counts as desktop. */
export function isDesktopAgent(userAgent: string | null): boolean {
  return !/Mobi|Android|iPhone|iPad|iPod/i.test(userAgent ?? "");
}

/** The sitemap navigation context for a standing and the request's conditions. */
export function navContext(input: {
  readonly standing: Standing | null;
  readonly companyAccount: boolean;
  readonly platformDomain: boolean;
  readonly desktop: boolean;
}): NavContext {
  const conditions: Condition[] = [];
  if (input.companyAccount) conditions.push("company-account");
  if (input.platformDomain) conditions.push("platform-domain");
  if (input.desktop) conditions.push("desktop");
  return { role: input.standing, conditions };
}
