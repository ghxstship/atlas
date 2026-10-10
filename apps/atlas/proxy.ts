import { NextResponse, type NextRequest } from "next/server";
import { createProxySupabase } from "@/lib/supabase/proxy";

/**
 * Atlas proxy (Next 16 renames middleware to proxy). Refreshes the Supabase session on every page
 * and server action request so tokens renew silently (Section 11.7).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { db, response } = createProxySupabase(request, () => NextResponse.next({ request }));
  await db.auth.getClaims();
  return response();
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
