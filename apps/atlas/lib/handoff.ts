import {
  appleAppSiteAssociation,
  assetLinks,
  handoffUrl,
  universalLinkConfig,
  universalLinksEnabled,
  type HandoffTarget,
} from "@xos/ia/handoff";
import { env, type Env } from "@/lib/env";

/**
 * Continue on another device (ADR 0030) for Atlas: the link a QR code carries and the universal link
 * files Atlas serves, all from the environment. Universal links stay off until the owner sets
 * COMPASS_APPLE_TEAM_IDS or COMPASS_ANDROID_CERT_SHA256; until then QR codes carry compass:// links.
 */
export function handoffLink(
  target: HandoffTarget,
  config: Env = env(),
): { readonly url: string; readonly universal: boolean } {
  const universal = universalLinksEnabled(universalLinkConfig(config));
  return {
    url: handoffUrl(target, { webOrigin: config.ATLAS_SITE_URL, universalLinks: universal }),
    universal,
  };
}

/** A JSON response for a universal link file, or 404 while it is not configured. */
export function universalLinkFile(body: unknown): Response {
  if (body === null) return new Response(null, { status: 404 });
  return Response.json(body, {
    headers: { "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
  });
}

export function appleAssociationFile(config: Env = env()): Response {
  return universalLinkFile(appleAppSiteAssociation(universalLinkConfig(config), "atlas"));
}

export function assetLinksFile(config: Env = env()): Response {
  return universalLinkFile(assetLinks(universalLinkConfig(config)));
}
