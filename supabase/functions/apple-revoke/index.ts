// Revoking Compass's Sign in with Apple tokens before an account deletion (ADR 0033 decision 58; App Store Review
// Guideline 5.1.1(v)): the signed-in person posts a fresh authorization code from Apple's sheet and their app's
// bundle ID; the function exchanges the code at Apple and revokes the refresh token, after checking that the Apple
// account is the one their XOS account signs in with (read from Supabase Auth with their own token). Nothing is stored.
// The key is an owner secret (APPLE_TEAM_ID, APPLE_SIGN_IN_KEY_ID, APPLE_SIGN_IN_KEY_PEM, APPLE_SIGN_IN_CLIENT_IDS);
// until it is set the function answers 503 apple_revoke_not_configured. The platform verifies the caller's JWT before
// this runs (verify_jwt stays on). It loads no npm package (A85): signing is Web Crypto, Apple and Supabase Auth are
// reached with fetch.
import {
  appleRevokeResponse,
  callerAppleSubjectLoader,
  readAppleRevokeEnv,
} from "../_vendor/apple-revoke.js";
import { env, json, serve } from "../_shared/runtime.ts";

serve(async (request) => {
  if (request.method !== "POST")
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer "))
    return json(401, { type: "/problems/unauthorized", title: "Sign in first.", status: 401 });
  const result = await appleRevokeResponse(await request.json().catch(() => null), {
    apple: readAppleRevokeEnv(Deno.env.toObject()),
    callerAppleSubject: callerAppleSubjectLoader({
      supabaseUrl: env("SUPABASE_URL"),
      anonKey: env("SUPABASE_ANON_KEY"),
      authorization,
    }),
  });
  return new Response(result.body, { status: result.status, headers: result.headers });
});
