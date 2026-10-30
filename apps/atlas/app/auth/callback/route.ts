import { joinBySsoSession } from "@xos/data/identity-providers";
import { NextResponse, type NextRequest } from "next/server";
import { authErrorKey, oauthCallbackError, type AuthErrorKey } from "@/lib/auth/errors";
import { isOAuthProvider } from "@/lib/auth/providers";
import { safeNext, signInErrorPath } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * A redirect within this site. The Location is relative, so the browser stays on the host it used:
 * Next names a loopback host localhost in request.url, and an absolute redirect built from it would
 * move a person signed in on 127.0.0.1 to localhost, where their new session cookie does not apply.
 */
function goTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

/**
 * OAuth, single sign-on and email-link (PKCE) return. Supabase Auth comes back with a code, which is
 * exchanged for the session cookies, or with the provider's refusal, which goes back to sign-in with
 * its message. `next` survives both ways (safeNext keeps it on this site), so an invitation or an org
 * page is where the person lands once signed in. `provider` is set by signInWithProvider: an OAuth
 * code that cannot be exchanged means the sign-in expired or started in another browser. After an
 * Enterprise single sign-on (A77) the person joins the identity provider's org when it adds people
 * just in time, and lands on that org's Home unless they were going somewhere.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const next = safeNext(params.get("next"));
  const oauth = isOAuthProvider(params.get("provider"));
  const back = (error: AuthErrorKey) => goTo(signInErrorPath(error, next));

  const refused = oauthCallbackError(params);
  if (refused) return back(refused);
  const code = params.get("code");
  if (!code) return back(oauth ? "oauth_expired" : "link_invalid");
  // With its appendPkceFlowIdToRedirects option on, auth-js adds sb_flow_id to the return address
  // and the exchange picks that flow's verifier when several sign-ins are in flight (two tabs).
  // Without it, as now, the verifier of the latest flow started in this browser is used.
  const flowId = params.get("sb_flow_id");
  const db = await createServerSupabase();
  const { data, error } = await db.auth.exchangeCodeForSession(
    code,
    flowId ? { flowId } : undefined,
  );
  if (error) {
    if (!oauth) return back("link_invalid");
    const key = authErrorKey(error);
    return back(key === "link_invalid" ? "oauth_expired" : key);
  }
  const provider = data.user?.app_metadata["provider"];
  if (typeof provider === "string" && provider.startsWith("sso:")) {
    const joined = await joinBySsoSession(db);
    // The org's blocklist (B16, 3050) refused the just-in-time join: the person hears the generic sentence.
    if (!joined.ok && joined.error.kind === "refusal" && joined.error.rule === "member_blocked") {
      return back("member_blocked");
    }
    if (joined.ok && joined.data && next === "/") return goTo(`/${joined.data.slug}/home`);
  }
  return goTo(next);
}
