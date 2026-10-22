// api-token: exchanges an `xos_live_` API key for a short-lived Supabase JWT acting as the key's service
// account (see mint.ts). Called by the public API runtime; it authenticates its caller by the key itself,
// so the function runs with verify_jwt = false. XOS_API_JWT_SIGNING_KEY is the project's JWT signing
// secret, set as a function secret; it never appears in code or tests. app.exchange_api_key is called
// over PostgREST with fetch, so the function loads no npm package (A85).
import { PlatformDbError } from "../_vendor/core.js";
import { env, serve, serviceDb } from "../_shared/runtime.ts";
import { exchangeResult, handleTokenRequest } from "./mint.ts";

serve(async (request) => {
  const db = serviceDb();
  return handleTokenRequest(request, {
    signingKey: env("XOS_API_JWT_SIGNING_KEY"),
    issuer: `${env("SUPABASE_URL")}/auth/v1`,
    exchange: async (secret) => {
      try {
        return exchangeResult(await db.rpc("exchange_api_key", { p_secret: secret }), null);
      } catch (error) {
        if (!(error instanceof PlatformDbError)) throw error;
        return exchangeResult(null, {
          message: error.databaseMessage,
          hint: error.hint,
          ...(error.code === null ? {} : { code: error.code }),
        });
      }
    },
  });
});
