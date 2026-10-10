import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Auth cookie policy (Section 9): httpOnly so page scripts never read the tokens, SameSite=Lax so
 * cross-site requests carry no session, Secure outside development, and scoped to the whole site.
 * Because the cookies are httpOnly, no browser Supabase client exists in Atlas; session state
 * reaches the page through server components and the /auth/session route.
 */
export function authCookieOptions(production: boolean): CookieOptionsWithName {
  return {
    name: "xos-auth",
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: production,
  };
}
