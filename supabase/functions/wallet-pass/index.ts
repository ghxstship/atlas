// Wallet passes for Compass (A93, RRR-138; Section 11.10 item 14): the signed-in person posts which of their
// own passes they want (a credential or a shift), for which wallet, and its labels in their language. The
// pass is read with the caller's own token through app.my_wallet_pass (1501, 2331), so nobody gets a pass for
// another person's badge; the answer is a signed .pkpass for Apple Wallet or a "Save to Google Wallet" link.
// The pass art comes from the org's logo in the public org-brand bucket when it is a PNG (A140), else the accent.
// The certificates and keys are owner secrets (APPLE_PASS_TYPE_ID, APPLE_TEAM_ID, APPLE_PASS_CERT_PEM,
// APPLE_PASS_KEY_PEM, APPLE_WWDR_CERT_PEM; GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
// GOOGLE_WALLET_PRIVATE_KEY_PEM); until they are set the function answers 503 wallet_not_configured.
// The platform verifies the caller's JWT before this runs (verify_jwt stays on). It loads no npm package
// (A85): signing is Web Crypto and the database is reached over PostgREST with fetch.
import {
  callerPassLoader,
  publicBrandLogo,
  readAppleWalletEnv,
  readGoogleWalletEnv,
  walletPassResponse,
} from "../_vendor/wallet-pass.js";
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
  const secrets = Deno.env.toObject();
  const result = await walletPassResponse(await request.json().catch(() => null), {
    apple: readAppleWalletEnv(secrets),
    google: readGoogleWalletEnv(secrets),
    loadPass: callerPassLoader({
      supabaseUrl: env("SUPABASE_URL"),
      anonKey: env("SUPABASE_ANON_KEY"),
      authorization,
    }),
    logo: publicBrandLogo({ supabaseUrl: env("SUPABASE_URL") }),
  });
  return new Response(result.body, { status: result.status, headers: result.headers });
});
