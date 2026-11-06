import "server-only";

import { addPackGrant } from "@xos/data/stakeholder-packs";
import { env } from "@/lib/env";

/**
 * The server half of the public stakeholder pack pages (B2, ADR 0141). The pages and handlers call the
 * token RPCs through the session-less client of lib/live-links/public.ts. A device may hold grants for
 * several packs, so one strictly necessary cookie on /share/pack keeps up to 8, newest first; nothing
 * else is set.
 */

/** The device grant cookie, HttpOnly, on /share/pack, holding up to 8 grants space-separated. */
export const PACK_GRANT_COOKIE = "xos_pack_grant";

/** The Set-Cookie value that adds a grant, keeping the device's others. */
export function packGrantCookie(current: string | null, grant: string, expiresAt: string): string {
  // Each grant expires by itself in the database; the cookie lasts as long as its newest grant may, 7 days.
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const secure = env().ATLAS_SITE_URL.startsWith("https:") ? "; Secure" : "";
  const value = encodeURIComponent(addPackGrant(current, grant));
  return `${PACK_GRANT_COOKIE}=${value}; Path=/share/pack; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure}`;
}

/** The cookie's value from a Cookie header, decoded. */
export function packGrantsFromHeader(header: string | null): string | null {
  const match = (header ?? "").split(/;\s*/).find((c) => c.startsWith(`${PACK_GRANT_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(PACK_GRANT_COOKIE.length + 1)) : null;
}
