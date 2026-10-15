import {
  getMyOrganization,
  hasClientOrganizations,
  listRoleCapabilities,
  systemRoleForBand,
  type MyOrganization,
  type SystemRoleCode,
  type XosClient,
} from "@xos/data";
import { getPersona, listDisabledModules } from "@xos/data/settings";
import type { Condition, NavContext } from "@xos/ia";

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

/** Desktop unless the client hints or the user agent say mobile (the `desktop` condition). */
export function isDesktopRequest(headers: Headers): boolean {
  if (headers.get("sec-ch-ua-mobile") === "?1") return false;
  return !/Mobi|Android|iPhone|iPad/i.test(headers.get("user-agent") ?? "");
}

/** Null when the org does not exist or the person holds no active membership in it. */
export async function resolveMembership(
  db: XosClient,
  personId: string,
  slug: string,
  headers: Headers,
): Promise<Membership | null> {
  const org = await getMyOrganization(db, personId, slug);
  if (!org.ok) {
    if (org.error.kind === "not-found") return null;
    throw new Error(`Cannot read organization ${slug}: ${JSON.stringify(org.error)}`);
  }
  const [capabilities, partner, disabled, persona] = await Promise.all([
    listRoleCapabilities(
      db,
      org.data.roles.map((r) => r.id),
    ),
    hasClientOrganizations(db, org.data.id),
    listDisabledModules(db, org.data.id),
    getPersona(db, org.data.id),
  ]);
  if (!capabilities.ok) {
    throw new Error(`Cannot read capabilities: ${JSON.stringify(capabilities.error)}`);
  }
  if (!partner.ok) throw new Error(`Cannot read client orgs: ${JSON.stringify(partner.error)}`);
  if (!disabled.ok)
    throw new Error(`Cannot read module switches: ${JSON.stringify(disabled.error)}`);
  if (!persona.ok) throw new Error(`Cannot read the persona: ${JSON.stringify(persona.error)}`);
  const role = org.data.bestBand === null ? null : systemRoleForBand(org.data.bestBand);
  const conditions: Condition[] = [];
  if (isDesktopRequest(headers)) conditions.push("desktop");
  if (partner.data) conditions.push("partner-org");
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
