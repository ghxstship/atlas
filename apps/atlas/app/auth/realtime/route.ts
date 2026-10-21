import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The access token for live updates (Section 11.7, ADR 0044). Session cookies are httpOnly, so the
 * page asks here for the short-lived access token Realtime authorizes with; row level security
 * then filters every change exactly as it filters a read. The refresh token never leaves the
 * cookie, and the page keeps the access token in memory only, asking again before it expires.
 *
 * Same-origin only: a cross-site page can neither read the answer (no CORS headers) nor have it
 * served (Sec-Fetch-Site). Reading the user first refreshes the tokens when they are due.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const headers = { "Cache-Control": "no-store", Vary: "Cookie" };
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") {
    return NextResponse.json({ error: "same_origin_only" }, { status: 403, headers });
  }
  const db = await createServerSupabase();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    if (error && (error.status ?? 500) >= 500) throw error;
    return NextResponse.json({ authenticated: false }, { status: 401, headers });
  }
  const { data: session } = await db.auth.getSession();
  const token = session.session?.access_token;
  const expiresAt = session.session?.expires_at;
  if (!token || !expiresAt) {
    return NextResponse.json({ authenticated: false }, { status: 401, headers });
  }
  const config = env();
  return NextResponse.json(
    {
      url: config.SUPABASE_URL,
      key: config.SUPABASE_ANON_KEY,
      token,
      expiresAt: expiresAt * 1000,
    },
    { headers },
  );
}
