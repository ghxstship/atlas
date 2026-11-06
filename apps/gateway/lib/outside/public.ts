import "server-only";

import { clientAddress, trustedProxyHops } from "@xos/data/client-address";
import { createPublicClient } from "@xos/data/client";
import type { XosClient } from "@xos/data/client";
import { env } from "@/lib/env";

/**
 * The server half of Gateway's public intake and form pages (B2, ADR 0141). The token RPCs run through a client with
 * no session, so a signed-in visitor reads a link as anyone else does. Each grant a correct code earns lives in one
 * strictly necessary cookie scoped to the link's own path; nothing else is set.
 */

export const INTAKE_GRANT_COOKIE = "xos_intake_grant";
export const FORM_GRANT_COOKIE = "xos_form_grant";

export function publicDb(): XosClient {
  const config = env();
  return createPublicClient({ url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY });
}

export function visitorAddress(headers: { get(name: string): string | null }): string | null {
  return clientAddress(headers, trustedProxyHops(process.env["XOS_TRUSTED_PROXY_HOPS"]));
}

export function pathGrantCookie(name: string, path: string, grant: string, expiresAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const secure = env().GATEWAY_SITE_URL.startsWith("https:") ? "; Secure" : "";
  return `${name}=${grant}; Path=${path}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure}`;
}

/** Headers every public response carries: never cached, never indexed, no referrer abroad. */
export const PUBLIC_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
};
