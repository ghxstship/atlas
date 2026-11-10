// api-token: exchanges an `xos_live_` API key for a short-lived Supabase JWT acting as the key's service
// account (see mint.ts). Called by the public API runtime; it authenticates its caller by the key itself,
// so the function runs with verify_jwt = false. The token is signed with XOS_API_JWT_SIGNING_KEY, a private JWK the
// project imported as a JWT signing key (ADR 0168, D5); it never appears in code or tests. app.exchange_api_key is called
// over PostgREST with fetch, so the function loads no npm package (A85).
import { PlatformDbError } from "../_vendor/core.js";
import { env, serve, serviceDb } from "../_shared/runtime.ts";
import { tokenSigner } from "../_shared/sessions.ts";
import { exchangeResult, handleTokenRequest } from "./mint.ts";

serve(async (request) => {
  const db = serviceDb();
  return handleTokenRequest(request, {
    sign: tokenSigner(),
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
