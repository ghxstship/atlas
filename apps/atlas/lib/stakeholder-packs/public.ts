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

/**
 * Each grant expires by itself in the database, so the cookie lasts as long as any grant in it may, 7 days. The new
 * grant's own expiry would not do: a pack ending tomorrow would take the device's grants for its other packs with it.
 */
const COOKIE_SECONDS = 7 * 24 * 60 * 60;

/** The Set-Cookie value that adds a grant, keeping the device's others and dropping those the database says are dead. */
export function packGrantCookie(
  current: string | null,
  grant: string,
  dead: readonly string[],
): string {
  const secure = env().ATLAS_SITE_URL.startsWith("https:") ? "; Secure" : "";
  const value = encodeURIComponent(addPackGrant(current, grant, dead));
  return `${PACK_GRANT_COOKIE}=${value}; Path=/share/pack; Max-Age=${COOKIE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

/** The cookie's value from a Cookie header, decoded. */
export function packGrantsFromHeader(header: string | null): string | null {
  const match = (header ?? "").split(/;\s*/).find((c) => c.startsWith(`${PACK_GRANT_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(PACK_GRANT_COOKIE.length + 1)) : null;
}
