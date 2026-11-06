import "server-only";

import { showcallerPath } from "@xos/data/showcaller-links";
import { env } from "@/lib/env";

/**
 * The server half of the showcaller portal (B3, ADR 0142). Reads and writes go through the session-less client of
 * lib/live-links/public.ts, never the visitor's own, so a signed-in visitor writes exactly as anyone with the link
 * does. The device grant a correct code earns lives in one strictly necessary cookie scoped to the portal's own
 * path; nothing else is set.
 */

export { PUBLIC_HEADERS, publicDb, visitorAddress } from "@/lib/live-links/public";

/** The device grant cookie, HttpOnly and scoped to /share/showcaller/{token}. */
export const SHOWCALLER_GRANT_COOKIE = "xos_showcaller_grant";

/**
 * The Set-Cookie value that keeps a grant on this device until it expires. SameSite=Lax, as P1's grant: a Strict
 * cookie is not sent on the top-level navigation from an email or a chat that opens the link, so every such open
 * would ask for the code again and use one of the link's five device grants. Cross-site writes are stopped by the
 * proxy's cross-site refusal, the Origin check of server actions and the path scope. Secure on an https site only,
 * so local runs over http work.
 */
export function showcallerGrantCookie(token: string, grant: string, expiresAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const secure = env().ATLAS_SITE_URL.startsWith("https:") ? "; Secure" : "";
  return `${SHOWCALLER_GRANT_COOKIE}=${grant}; Path=${showcallerPath(token)}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure}`;
}
