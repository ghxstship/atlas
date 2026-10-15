import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Sign out (POST only, so a link or image can never sign anyone out). The proxy refuses a POST
 * whose Origin is another site. Other tabs learn through BroadcastChannel (Section 11.7).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = await createServerSupabase();
  const { error } = await db.auth.signOut({ scope: "local" });
  if (error && (error.status ?? 500) >= 500) throw error;
  return NextResponse.redirect(new URL("/auth/sign-in?signedOut=1", request.url), 303);
}
