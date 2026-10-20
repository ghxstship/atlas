import { NextResponse, type NextRequest } from "next/server";
import { authErrorKey, oauthCallbackError, type AuthErrorKey } from "@/lib/auth/errors";
import { isOAuthProvider } from "@/lib/auth/providers";
import { safeNext, signInErrorPath } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * OAuth and email-link (PKCE) return. Supabase Auth comes back with a code, which is exchanged for
 * the session cookies, or with the provider's refusal, which goes back to sign-in with its message.
 * `next` survives both ways (safeNext keeps it on this site), so an invitation or an org page is
 * where the person lands once signed in. `provider` is set by signInWithProvider: an OAuth code
 * that cannot be exchanged means the sign-in expired or started in another browser.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const next = safeNext(params.get("next"));
  const oauth = isOAuthProvider(params.get("provider"));
  const back = (error: AuthErrorKey) =>
    NextResponse.redirect(new URL(signInErrorPath(error, next), request.url));

  const refused = oauthCallbackError(params);
  if (refused) return back(refused);
  const code = params.get("code");
  if (!code) return back(oauth ? "oauth_expired" : "link_invalid");
  // With its appendPkceFlowIdToRedirects option on, auth-js adds sb_flow_id to the return address
  // and the exchange picks that flow's verifier when several sign-ins are in flight (two tabs).
  // Without it, as now, the verifier of the latest flow started in this browser is used.
  const flowId = params.get("sb_flow_id");
  const db = await createServerSupabase();
  const { error } = await db.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
  if (error) {
    if (!oauth) return back("link_invalid");
    const key = authErrorKey(error);
    return back(key === "link_invalid" ? "oauth_expired" : key);
  }
  return NextResponse.redirect(new URL(next, request.url));
}
