import { brandForHost, type XosClient } from "@xos/data/gateway";
import { checkAccent, HEX_COLOR } from "./contrast";

/**
 * Gateway white label (Section 4.4.7, Section 12). On the platform domain Gateway wears the
 * platform brand and a person sees all their orgs. On an org's verified custom Gateway domain it
 * shows only that org, in its brand: name, logos, accent and the Powered by XOS line the Pro plan
 * may hide. The host lookup is A30's api_public.org_brand_for_host (0850).
 */
export interface OrgBrand {
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly logoLightPath: string | null;
  readonly logoDarkPath: string | null;
  /** The app icon in the org-brand bucket, which the installed Gateway shows on a custom domain (A96). */
  readonly appIconPath: string | null;
  /** Six-digit hex accent; applied only when it passes the contrast gate. */
  readonly accent: string | null;
  readonly showPoweredBy: boolean;
}

export type GatewayBrand =
  { readonly kind: "platform" } | { readonly kind: "org"; readonly org: OrgBrand };

/** The host without a port, lowercased. */
export function hostName(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "");
}

/**
 * Resolves the brand for a request host. Platform hosts never consult the lookup. A host the
 * lookup does not know renders the platform brand, never another org's identity; a lookup
 * failure is raised, because showing the wrong brand is worse than an error page.
 */
export async function resolveBrand(
  db: XosClient,
  host: string | null,
  platformDomain: boolean,
): Promise<GatewayBrand> {
  if (platformDomain || !host) return { kind: "platform" };
  const result = await brandForHost(db, hostName(host));
  if (!result.ok)
    throw new Error(`Brand lookup failed for ${hostName(host)}: ${result.error.kind}`);
  const row = result.data;
  if (!row) return { kind: "platform" };
  return {
    kind: "org",
    org: {
      orgId: row.org_id,
      slug: row.org_slug,
      name: row.name,
      logoLightPath: row.logo_light_path,
      logoDarkPath: row.logo_dark_path,
      appIconPath: row.app_icon_path,
      accent: row.accent_hex,
      showPoweredBy: !row.suppress_powered_by,
    },
  };
}

/**
 * CSS custom properties that apply an org accent. Every override is token based (Section 12); an
 * accent that fails WCAG 2.2 AA in any theme is dropped, so a failing palette can never render.
 */
export function brandStyle(brand: GatewayBrand): Record<string, string> {
  if (brand.kind !== "org" || !brand.org.accent || !HEX_COLOR.test(brand.org.accent)) return {};
  return checkAccent(brand.org.accent).passes
    ? { "--color-accent-default": brand.org.accent.toUpperCase() }
    : {};
}

/** On an org's custom domain, only that org's rows show (Section 4.4.7). */
export function inBrandScope(brand: GatewayBrand, orgId: string): boolean {
  return brand.kind === "platform" || brand.org.orgId === orgId;
}
