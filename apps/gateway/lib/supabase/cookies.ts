import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Auth cookie policy (Section 9): httpOnly so page scripts never read the tokens, SameSite=Lax so
 * cross-site requests carry no session, Secure whenever Gateway is served over https, and scoped to
 * the whole site. The account is the same one Atlas uses (Section 4.4.1); each host keeps its own
 * session cookie, so signing in on a custom Gateway domain never exposes the platform session.
 */
export function authCookieOptions(secureSite: boolean): CookieOptionsWithName {
  return {
    name: "xos-auth",
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: secureSite,
  };
}
