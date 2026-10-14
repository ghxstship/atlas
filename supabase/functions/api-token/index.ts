// api-token: exchanges an `xos_live_` API key for a short-lived Supabase JWT acting as the key's service
// account (see mint.ts). Called by the public API runtime; it authenticates its caller by the key itself,
// so the function runs with verify_jwt = false. XOS_API_JWT_SIGNING_KEY is the project's JWT signing
// secret, set as a function secret; it never appears in code or tests.
import { createClient } from "@supabase/supabase-js";
import { env, serve } from "../_shared/runtime.ts";
import { exchangeResult, handleTokenRequest } from "./mint.ts";

serve(async (request) => {
  const service = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleTokenRequest(request, {
    signingKey: env("XOS_API_JWT_SIGNING_KEY"),
    issuer: `${env("SUPABASE_URL")}/auth/v1`,
    exchange: async (secret) => {
      const { data, error } = await service
        .schema("app")
        .rpc("exchange_api_key", { p_secret: secret });
      return exchangeResult(data, error);
    },
  });
});
