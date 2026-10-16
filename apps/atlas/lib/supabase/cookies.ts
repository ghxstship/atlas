import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Auth cookie policy (Section 9): httpOnly so page scripts never read the tokens, SameSite=Lax so
 * cross-site requests carry no session, Secure whenever Atlas is served over https, and scoped to the whole site.
 * Because the cookies are httpOnly, no browser Supabase client exists in Atlas; session state
 * reaches the page through server components and the /auth/session route.
 *
 * Over https the cookie carries the __Host- prefix (A22-014, ASVS V3.3.3): the browser then accepts
 * it only with Secure, Path=/ and no Domain, so a sibling subdomain or a plain-http response cannot
 * plant a session cookie under the same name. Local http development keeps the unprefixed name,
 * because browsers refuse prefixed cookies without Secure.
 */
export function authCookieName(secureSite: boolean): string {
  return secureSite ? "__Host-xos-auth" : "xos-auth";
}

/** Cookie options for @supabase/ssr; see authCookieName for the name. */
export function authCookieOptions(secureSite: boolean): CookieOptionsWithName {
  return {
    name: authCookieName(secureSite),
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: secureSite,
  };
}
