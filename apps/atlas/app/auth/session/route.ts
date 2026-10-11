import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Session status for the re-authentication dialog (Section 11.7). Reading the user refreshes the
 * tokens when they are due, so an active person never sees the dialog; 401 means the session is
 * gone and the dialog opens over the page.
 */
export async function GET(): Promise<NextResponse> {
  const db = await createServerSupabase();
  const { data, error } = await db.auth.getUser();
  const headers = { "Cache-Control": "no-store" };
  if (error || !data.user) {
    if (error && (error.status ?? 500) >= 500) throw error;
    return NextResponse.json({ authenticated: false }, { status: 401, headers });
  }
  return NextResponse.json({ authenticated: true, userId: data.user.id }, { headers });
}
