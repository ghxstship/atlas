import "server-only";

import { clientAddress, trustedProxyHops } from "@xos/data/client-address";
import { createPublicClient } from "@xos/data/client";
import type { XosClient } from "@xos/data";
import { liveLinkPath, type LiveLinkKind } from "@xos/data/live-links";
import { env } from "@/lib/env";

/**
 * The server half of the public live link pages (P1, ADR 0130). The pages and the open handlers call
 * the token RPCs through a client with no session at all, never the visitor's own, so a signed-in
 * visitor reads a link exactly as anyone else does. The device grant a correct code earns lives in
 * one strictly necessary cookie scoped to the link's own path; nothing else is set.
 */

/** The device grant cookie, HttpOnly and scoped to /share/view/{token} or /share/screen/{token}. */
export const GRANT_COOKIE = "xos_link_grant";

/** A session-less anonymous client for the token RPCs. */
export function publicDb(): XosClient {
  const config = env();
  return createPublicClient({ url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY });
}

/** The visitor's address behind the trusted proxies, relayed to the RPCs for the failure limit. */
export function visitorAddress(headers: { get(name: string): string | null }): string | null {
  return clientAddress(headers, trustedProxyHops(env().XOS_TRUSTED_PROXY_HOPS));
}

/** The Set-Cookie value that keeps a grant on this device until it expires. */
export function grantCookie(
  kind: LiveLinkKind,
  token: string,
  grant: string,
  expiresAt: string,
): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const secure = env().ATLAS_SITE_URL.startsWith("https:") ? "; Secure" : "";
  return `${GRANT_COOKIE}=${grant}; Path=${liveLinkPath(kind, token)}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure}`;
}

/** Headers every public live link response carries: never cached, never indexed, no referrer abroad. */
export const PUBLIC_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
};
