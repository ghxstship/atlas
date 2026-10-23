import {
  APP_ENUMS,
  type ExternalRoleType,
  type MarketplaceFilter,
  type MarketplacePlace,
  type MarketplacePoint,
  type MarketplaceSort,
  type RecommendationParts,
} from "@xos/data/gateway";
import { parseMoneyInput } from "./format";

/**
 * Explore query parameters to a marketplace filter. Unknown values are dropped rather than
 * guessed, so a hand-edited URL narrows nothing it does not name.
 */
export type ExploreQuery = Readonly<Record<string, string | string[] | undefined>>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DISCIPLINE = /^\d{4}\.\d{2}$/;
const CATEGORY = /^\d{4}\.\d{2}\.\d{2}$/;

/** Radii Explore offers for distance, in kilometers (the database caps a radius at 500). */
export const RADII_KM = [10, 25, 50, 100, 250] as const;
const DEFAULT_RADIUS_KM = 50;

function first(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : (value?.[0] ?? "");
}

export interface ParsedExplore {
  readonly q: string;
  readonly roles: ExternalRoleType[];
  readonly from: string;
  readonly to: string;
  readonly minPay: string;
  /** Canon discipline code, DDDD.DD. */
  readonly disc: string;
  /** Canon category URID, DDDD.DD.DD, inside the discipline when one is chosen. */
  readonly cat: string;
  /** Required certification, by name. */
  readonly cert: string;
  /** Place to search near, by its label in the places list. */
  readonly near: string;
  readonly radiusKm: number;
  readonly sort: MarketplaceSort;
  /** Show the listings the person passed on. */
  readonly passed: boolean;
  /** The filter without the place, which resolvePlace adds once the places are known. */
  readonly filter: MarketplaceFilter;
}

export function parseExploreQuery(query: ExploreQuery): ParsedExplore {
  const q = first(query["q"]).trim().slice(0, 200);
  const rawRoles = typeof query["role"] === "string" ? [query["role"]] : (query["role"] ?? []);
  const roles = rawRoles.filter((r): r is ExternalRoleType =>
    (APP_ENUMS.external_role_type as readonly string[]).includes(r),
  );
  const from = ISO_DATE.test(first(query["from"])) ? first(query["from"]) : "";
  const to = ISO_DATE.test(first(query["to"])) ? first(query["to"]) : "";
  const minPay = first(query["minPay"]).trim();
  const minPayMinor = minPay ? parseMoneyInput(minPay, "USD") : null;
  const disc = DISCIPLINE.test(first(query["disc"])) ? first(query["disc"]) : "";
  const rawCat = first(query["cat"]);
  const cat = CATEGORY.test(rawCat) && (!disc || rawCat.startsWith(`${disc}.`)) ? rawCat : "";
  const cert = first(query["cert"]).trim().slice(0, 200);
  const near = first(query["near"]).trim().slice(0, 200);
  const radius = Number(first(query["radius"]));
  const radiusKm = (RADII_KM as readonly number[]).includes(radius) ? radius : DEFAULT_RADIUS_KM;
  const sort: MarketplaceSort = first(query["sort"]) === "soonest" ? "soonest" : "recommended";
  const passed = first(query["passed"]) === "1";
  return {
    q,
    roles,
    from,
    to,
    minPay,
    disc,
    cat,
    cert,
    near,
    radiusKm,
    sort,
    passed,
    filter: {
      ...(q ? { query: q } : {}),
      ...(roles.length > 0 ? { roleTypes: roles } : {}),
      ...(from ? { startsAfter: from } : {}),
      ...(to ? { endsBefore: to } : {}),
      ...(minPayMinor !== null ? { minPayMinor } : {}),
      ...(disc ? { discCode: disc } : {}),
      ...(cat ? { catUrid: cat } : {}),
      ...(cert ? { certificationName: cert } : {}),
      sort,
      includePassed: passed,
    },
  };
}

/** The point to search near: the named place from the list, with the chosen radius; null when unknown. */
export function resolvePlace(
  parsed: Pick<ParsedExplore, "near" | "radiusKm">,
  places: readonly MarketplacePlace[],
): MarketplacePoint | null {
  if (!parsed.near) return null;
  const place = places.find((p) => p.label.toLowerCase() === parsed.near.toLowerCase());
  return place
    ? {
        label: place.label,
        latitude: place.latitude,
        longitude: place.longitude,
        radiusKm: parsed.radiusKm,
      }
    : null;
}

/** Whether any filter narrows the marketplace (the order and showing passed listings do not). */
export function hasFilters(parsed: ParsedExplore): boolean {
  return (
    parsed.q !== "" ||
    parsed.roles.length > 0 ||
    parsed.from !== "" ||
    parsed.to !== "" ||
    parsed.minPay !== "" ||
    parsed.disc !== "" ||
    parsed.cat !== "" ||
    parsed.cert !== "" ||
    parsed.near !== ""
  );
}

/** Whether a filter behind More fields is set, so the disclosure opens. */
export function hasMoreFilters(parsed: ParsedExplore): boolean {
  return Boolean(
    parsed.from ||
    parsed.to ||
    parsed.minPay ||
    parsed.disc ||
    parsed.cat ||
    parsed.cert ||
    parsed.near ||
    parsed.passed,
  );
}

/** The reasons a listing is recommended, strongest first, as catalog keys under gateway.explore.why. */
export type RecommendationReason =
  "skills" | "discipline" | "certifications" | "near" | "available";

export function recommendationReasons(r: RecommendationParts): RecommendationReason[] {
  const reasons: RecommendationReason[] = [];
  if (r.skills >= 40) reasons.push("skills");
  else if (r.skills >= 25) reasons.push("discipline");
  if (r.certificationsRequired > 0 && r.certificationsMet === r.certificationsRequired) {
    reasons.push("certifications");
  }
  if (r.location >= 20) reasons.push("near");
  if (r.availability >= 10) reasons.push("available");
  return reasons;
}

/**
 * Views Explore can show today. The sitemap lists map as well, and Section 11.15 forbids offering a
 * view the data does not qualify for, so map is offered only when some listing carries coordinates.
 */
export function exploreViews(listed: readonly string[], hasCoordinates: boolean): string[] {
  return listed.filter((v) => v !== "map" || hasCoordinates);
}
