import {
  getMyOrganization,
  isPartnerOrganization,
  listRoleCapabilities,
  systemRoleForBand,
  type MyOrganization,
  type SystemRoleCode,
  type XosClient,
} from "@xos/data";
import { networkAccess } from "@xos/data/access-controls";
import { getOrgAuthStatus, orgAuthDecision, type OrgAuthDecision } from "@xos/data/auth-assurance";
import { orgAllowsPersonalTokens } from "@xos/data/developer";
import { getPersona, listDisabledModules } from "@xos/data/settings";
import type { Condition, NavContext } from "@xos/ia";
import { LAST_SEEN_COOKIE, parseLastSeen } from "@/lib/auth/assurance";
import { clientIp } from "@/lib/auth/legal";

/**
 * A person's standing in one org, shared by the proxy route guard and the page context so both
 * apply the same rule: the role is the system role of the best band held (custom roles take bands
 * 2 to 7, ADR 0008), the sitemap conditions come from the org and the device, and modules the org
 * turned off (app.org_module_states) leave navigation, search and the command menu.
 */
export interface Membership {
  readonly org: MyOrganization;
  readonly role: SystemRoleCode | null;
  readonly capabilities: ReadonlySet<string>;
  readonly nav: NavContext;
  /** The persona the person chose for this org (Preferences), or null to follow the role. */
  readonly persona: string | null;
}

/**
 * The org setting that allows personal API tokens (Section 4.5.6 personal settings item 15, migration 1432).
 * While it is off, Personal settings, Developer is not in the sitemap for the org's members.
 */
export const PERSONAL_TOKENS_SETTING = "developer.personal_tokens";

/** The sitemap conditions of a request in an org, from the device and what the org allows. */
export function membershipConditions(input: {
  readonly desktop: boolean;
  readonly partner: boolean;
  /** developer.personal_tokens is on and the plan has the api_keys feature (app.org_allows_personal_tokens). */
  readonly personalTokens: boolean;
}): Condition[] {
  const conditions: Condition[] = [];
  if (input.desktop) conditions.push("desktop");
  if (input.partner) conditions.push("partner-org");
  if (input.personalTokens) conditions.push("org-allows-personal-tokens");
  return conditions;
}

/** Desktop unless the client hints or the user agent say mobile (the `desktop` condition). */
export function isDesktopRequest(headers: Headers): boolean {
  if (headers.get("sec-ch-ua-mobile") === "?1") return false;
  return !/Mobi|Android|iPhone|iPad/i.test(headers.get("user-agent") ?? "");
}

/** One cookie from a request's Cookie header. */
function cookieValue(headers: Headers, name: string): string | undefined {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Null when the org does not exist, the person holds no active membership in it, or the org's IP
 * allow-list refuses the address the request came from (Section 9, migration 1201); then
 * `onRestricted` is called, so the proxy can explain the refusal instead of answering 404. An org
 * that never turned its allow-list on admits every address.
 *
 * Also null when the session does not meet the org's security settings (A77, migration 1330): a
 * second factor its MFA policy asks of the person's role, its session lifetime or its idle timeout.
 * Then `auth.onRequired` gets the reason, so the proxy sends the person to verify or sign in again.
 * Server actions resolve their org here too, so an action naming another org meets the same rules.
 * The device's last request comes from the `xos-last-seen` cookie unless `auth.lastSeenAt` gives it
 * (the proxy reads it before it records this request).
 */
export async function resolveMembership(
  db: XosClient,
  personId: string,
  slug: string,
  headers: Headers,
  onRestricted?: () => void,
  auth?: {
    readonly onRequired?: (decision: OrgAuthDecision) => void;
    readonly lastSeenAt?: number | null;
  },
): Promise<Membership | null> {
  const org = await getMyOrganization(db, personId, slug);
  if (!org.ok) {
    if (org.error.kind === "not-found") return null;
    throw new Error(`Cannot read organization ${slug}: ${JSON.stringify(org.error)}`);
  }
  const [network, capabilities, partner, disabled, persona, session, tokens] = await Promise.all([
    networkAccess(db, org.data.id, clientIp(headers)),
    listRoleCapabilities(
      db,
      org.data.roles.map((r) => r.id),
    ),
    isPartnerOrganization(db, org.data.id),
    listDisabledModules(db, org.data.id),
    getPersona(db, org.data.id),
    getOrgAuthStatus(db, org.data.id),
    orgAllowsPersonalTokens(db, org.data.id),
  ]);
  if (!network.ok)
    throw new Error(`Cannot check the IP allow-list: ${JSON.stringify(network.error)}`);
  if (!network.data.allowed) {
    onRestricted?.();
    return null;
  }
  if (!session.ok) {
    throw new Error(`Cannot read the org's session rules: ${JSON.stringify(session.error)}`);
  }
  if (session.data) {
    const decision = orgAuthDecision(session.data, {
      lastSeenAt:
        auth?.lastSeenAt !== undefined
          ? auth.lastSeenAt
          : parseLastSeen(cookieValue(headers, LAST_SEEN_COOKIE)),
      now: Date.now(),
    });
    if (decision !== "ok") {
      auth?.onRequired?.(decision);
      return null;
    }
  }
  if (!capabilities.ok) {
    throw new Error(`Cannot read capabilities: ${JSON.stringify(capabilities.error)}`);
  }
  if (!partner.ok) throw new Error(`Cannot read client orgs: ${JSON.stringify(partner.error)}`);
  if (!disabled.ok)
    throw new Error(`Cannot read module switches: ${JSON.stringify(disabled.error)}`);
  if (!persona.ok) throw new Error(`Cannot read the persona: ${JSON.stringify(persona.error)}`);
  if (!tokens.ok) {
    throw new Error(`Cannot read ${PERSONAL_TOKENS_SETTING}: ${JSON.stringify(tokens.error)}`);
  }
  const role = org.data.bestBand === null ? null : systemRoleForBand(org.data.bestBand);
  const conditions = membershipConditions({
    desktop: isDesktopRequest(headers),
    partner: partner.data,
    personalTokens: tokens.data,
  });
  return {
    org: org.data,
    role,
    capabilities: new Set(
      [...capabilities.data].filter(([, reach]) => reach === "organization").map(([c]) => c),
    ),
    nav: { role, conditions, disabledModules: disabled.data },
    persona: persona.data,
  };
}
