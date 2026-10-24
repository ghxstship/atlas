import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Auth cookie policy (Section 9), as Gateway's: httpOnly so page scripts never read the tokens, SameSite=Lax so
 * cross-site requests carry no session, Secure over https and scoped to the whole site. Over https the name carries
 * the __Host- prefix (ASVS V3.3.3), so no sibling subdomain (atlas., gateway.) can plant or read a console session:
 * the console keeps its own session on its own host, and an Atlas session never opens it.
 */
export function authCookieName(secure: boolean): string {
  return secure ? "__Host-xos-console-auth" : "xos-console-auth";
}

export function authCookieOptions(secure: boolean): CookieOptionsWithName {
  return {
    name: authCookieName(secure),
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure,
  };
}
