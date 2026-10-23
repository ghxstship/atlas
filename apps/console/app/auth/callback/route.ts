import { getOperator } from "@xos/data/console";
import { NextResponse, type NextRequest } from "next/server";
import { signInErrorKey, type SignInErrorKey } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

const HOME = "/tenants";

/** A redirect within this site; a relative Location keeps the browser on the host it used. */
function goTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

/**
 * Sign in with Google returns here (ADR 0036, PKCE). The code is exchanged for the session; an account off the
 * platform team is signed out at once and sent back to sign-in with not_operator. An operator continues to the
 * second factor.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const next = safeNext(params.get("next"), HOME);
  const back = (error: SignInErrorKey) =>
    goTo(`/auth/sign-in?${new URLSearchParams({ error, next }).toString()}`);
  if (params.get("error") || params.get("error_code")) return back("provider_error");
  const code = params.get("code");
  if (!code) return back("link_invalid");
  const db = await createServerSupabase();
  const { error } = await db.auth.exchangeCodeForSession(code);
  if (error) {
    const key = signInErrorKey(error);
    return back(key === "unexpected" ? "link_invalid" : key);
  }
  const operator = await getOperator(db);
  if (!operator.ok || !operator.data) {
    await db.auth.signOut({ scope: "local" });
    return back("not_operator");
  }
  return goTo(`/auth/second-factor?next=${encodeURIComponent(next)}`);
}
