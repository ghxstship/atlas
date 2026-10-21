import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

/** Ends the console session (POST only; the proxy refuses a cross-site POST). */
export async function POST(): Promise<NextResponse> {
  const db = await createServerSupabase();
  await db.auth.signOut({ scope: "local" });
  return new NextResponse(null, { status: 303, headers: { location: "/auth/sign-in" } });
}
