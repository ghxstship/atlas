import { APP_ENUMS, type ExternalRoleType, type OpportunityFilter } from "@xos/data";
import { parseMoneyInput } from "./format";

/**
 * Explore query parameters to a marketplace filter. Unknown values are dropped rather than
 * guessed, so a hand-edited URL narrows nothing it does not name.
 */
export type ExploreQuery = Readonly<Record<string, string | string[] | undefined>>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function first(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : (value?.[0] ?? "");
}

export function parseExploreQuery(query: ExploreQuery): {
  readonly q: string;
  readonly roles: ExternalRoleType[];
  readonly from: string;
  readonly to: string;
  readonly minPay: string;
  readonly filter: OpportunityFilter;
} {
  const q = first(query["q"]).trim().slice(0, 200);
  const rawRoles = typeof query["role"] === "string" ? [query["role"]] : (query["role"] ?? []);
  const roles = rawRoles.filter((r): r is ExternalRoleType =>
    (APP_ENUMS.external_role_type as readonly string[]).includes(r),
  );
  const from = ISO_DATE.test(first(query["from"])) ? first(query["from"]) : "";
  const to = ISO_DATE.test(first(query["to"])) ? first(query["to"]) : "";
  const minPay = first(query["minPay"]).trim();
  const minPayMinor = minPay ? parseMoneyInput(minPay, "USD") : null;
  return {
    q,
    roles,
    from,
    to,
    minPay,
    filter: {
      ...(q ? { query: q } : {}),
      ...(roles.length > 0 ? { roleTypes: roles } : {}),
      ...(from ? { startsAfter: from } : {}),
      ...(to ? { endsBefore: to } : {}),
      ...(minPayMinor !== null ? { minPayMinor } : {}),
    },
  };
}

/** Whether any filter narrows the marketplace. */
export function hasFilters(parsed: ReturnType<typeof parseExploreQuery>): boolean {
  return parsed.q !== "" || parsed.roles.length > 0 || parsed.from !== "" || parsed.to !== "" || parsed.minPay !== "";
}

/**
 * Views Explore can show today. The sitemap lists map as well, but no opportunity carries
 * coordinates until venues gain a location (A09), and Section 11.15 forbids offering a view the
 * data does not qualify for, so map is withheld until then.
 */
export function exploreViews(listed: readonly string[], hasCoordinates: boolean): string[] {
  return listed.filter((v) => v !== "map" || hasCoordinates);
}
