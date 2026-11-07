import "server-only";

import type { XosClient } from "@xos/data";
import { showcallerPath } from "@xos/data/showcaller-links";
import { env } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The server half of the showcaller portal (B3, ADR 0142). By the owner's ruling of 2026-11-06 a token and code alone
 * open nothing: reads and writes go through the signed-in person's own client, and the database checks that they are
 * on the project. The device grant a correct code earns lives in one strictly necessary cookie scoped to the portal's
 * own path; nothing else is set.
 */

export { PUBLIC_HEADERS, visitorAddress } from "@/lib/live-links/public";

/** The visitor's client, and whether anyone is signed in. api_public.*showcaller* is not granted to anon. */
export async function portalSession(): Promise<{ db: XosClient; signedIn: boolean }> {
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  return { db, signedIn: data.user !== null };
}

/** Sign in, then back to this link. Someone with no account comes through their invitation first. */
export function showcallerSignInPath(token: string): string {
  return `/auth/sign-in?next=${encodeURIComponent(showcallerPath(token))}`;
}

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
