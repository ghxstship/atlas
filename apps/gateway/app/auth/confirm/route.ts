import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, recordPendingAcceptances } from "@/lib/auth/legal";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

const OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

/** Email links that carry a token hash (`{{ .TokenHash }}` templates): verifies it, then continues. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const next = safeNext(params.get("next"));
  if (!tokenHash || !type || !OTP_TYPES.includes(type)) {
    return NextResponse.redirect(new URL("/auth/sign-in?error=link_invalid", request.url));
  }
  const db = await createServerSupabase();
  const { error } = await db.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) return NextResponse.redirect(new URL("/auth/sign-in?error=link_invalid", request.url));
  // A new account accepted the Worker Terms at sign-up; the first session writes them to the log.
  await recordPendingAcceptances(db, clientIp(request.headers));
  return NextResponse.redirect(new URL(next, request.url));
}
