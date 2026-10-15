import { checkAccent, HEX_COLOR } from "./contrast";

/**
 * Gateway white label (Section 4.4.7, Section 12). On the platform domain Gateway wears the
 * platform brand and a person sees all their orgs. On an org's custom Gateway domain it shows only
 * that org, in its brand: name, logos, accent and the Powered by XOS line the Pro plan may hide.
 *
 * Brand storage and the host lookup belong to RRR-73 (A30): an `api_public` projection from a
 * verified custom domain to the org's brand. Gateway reads it through `BrandSource`; until that
 * projection exists the source answers no brand for every host, so custom domains render the
 * platform brand and every org, never another org's identity.
 */
export interface OrgBrand {
  readonly orgId: string;
  readonly name: string;
  readonly logoLightUrl: string | null;
  readonly logoDarkUrl: string | null;
  /** Six-digit hex accent; applied only when it passes the contrast gate. */
  readonly accent: string | null;
  readonly showPoweredBy: boolean;
}

export interface BrandSource {
  /** The org whose verified custom Gateway domain is `host`, or null. */
  forHost(host: string): Promise<OrgBrand | null>;
}

/** The source in force until the RRR-73 host lookup lands: no host maps to an org. */
export const noCustomDomains: BrandSource = {
  forHost: async () => null,
};

export type GatewayBrand =
  | { readonly kind: "platform" }
  | { readonly kind: "org"; readonly org: OrgBrand };

/** Resolves the brand for a request host. Platform hosts never consult the source. */
export async function resolveBrand(
  host: string | null,
  platformDomain: boolean,
  source: BrandSource = noCustomDomains,
): Promise<GatewayBrand> {
  if (platformDomain || !host) return { kind: "platform" };
  const org = await source.forHost(host.toLowerCase().replace(/:\d+$/, ""));
  return org ? { kind: "org", org } : { kind: "platform" };
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
