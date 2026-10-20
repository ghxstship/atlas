import { joinBySsoSession } from "@xos/data/identity-providers";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * OAuth, single sign-on and email-link (PKCE) return: exchanges the code for a session, then continues. After an
 * Enterprise single sign-on (A77) the person joins the identity provider's org when it adds people just in time,
 * and lands on that org's Home unless they were going somewhere.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  if (!code) return NextResponse.redirect(new URL("/auth/sign-in?error=link_invalid", request.url));
  const db = await createServerSupabase();
  const { data, error } = await db.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL("/auth/sign-in?error=link_invalid", request.url));
  const provider = data.user?.app_metadata["provider"];
  if (typeof provider === "string" && provider.startsWith("sso:")) {
    const joined = await joinBySsoSession(db);
    if (joined.ok && joined.data && next === "/") {
      return NextResponse.redirect(new URL(`/${joined.data.slug}/home`, request.url));
    }
  }
  return NextResponse.redirect(new URL(next, request.url));
}
