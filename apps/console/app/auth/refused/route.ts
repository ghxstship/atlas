import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * A session whose account is not, or no longer, on the platform team (a revoked role, an Atlas account) is signed
 * out here and told so on the sign-in page. Signing out is the only effect, so a forged link can do no more than
 * end a console session.
 */
export async function GET(): Promise<NextResponse> {
  const db = await createServerSupabase();
  await db.auth.signOut({ scope: "local" });
  return new NextResponse(null, {
    status: 307,
    headers: { location: "/auth/sign-in?error=not_operator" },
  });
}
