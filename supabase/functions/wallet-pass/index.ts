// Wallet passes for Compass (A93, RRR-138; Section 11.10 item 14): the signed-in person posts which of their
// own passes they want (a credential or a shift) and for which wallet. The pass is read with the caller's
// own token through app.my_wallet_pass (1501), so nobody gets a pass for another person's badge; the answer
// is a signed .pkpass for Apple Wallet or a "Save to Google Wallet" link. The certificates and keys are
// owner secrets (APPLE_PASS_TYPE_ID, APPLE_TEAM_ID, APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM,
// APPLE_WWDR_CERT_PEM; GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
// GOOGLE_WALLET_PRIVATE_KEY_PEM); until they are set the function answers 503 wallet_not_configured.
// The platform verifies the caller's JWT before this runs (verify_jwt stays on).
import { createClient } from "@supabase/supabase-js";
import {
  passFromRow,
  readAppleWalletEnv,
  readGoogleWalletEnv,
  walletPassResponse,
} from "../_vendor/xos-platform.js";
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
  const caller = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const secrets = Deno.env.toObject();
  const result = await walletPassResponse(await request.json().catch(() => null), {
    apple: readAppleWalletEnv(secrets),
    google: readGoogleWalletEnv(secrets),
    loadPass: async (kind, id) => {
      const { data, error } = await caller.rpc("my_wallet_pass", { p_kind: kind, p_id: id });
      if (error) throw new Error(`my_wallet_pass failed: ${error.message}`);
      return passFromRow((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null);
    },
  });
  return new Response(result.body, { status: result.status, headers: result.headers });
});
