// scim: the SCIM 2.0 endpoint identity providers call to add, change and remove people and groups (Section 9,
// Enterprise plan; A77). Base URL: <project>/functions/v1/scim/v2, for example /functions/v1/scim/v2/Users.
// The caller authenticates with the org's SCIM bearer token, issued with step-up on Settings, Security and kept
// only as its SHA-256 (migration 0638), so the function runs with verify_jwt = false. Joins, roles, teams and
// offboarding run in SQL (app.scim_provision); the handler lives in @xos/integrations (identity/scim.ts).
import { createClient } from "@supabase/supabase-js";
import { serveScim, supabaseAuthAdmin, supabaseScimStore } from "../_vendor/xos-platform.js";
import { env, serve } from "../_shared/runtime.ts";

serve(async (request) => {
  const service = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    db: { schema: "app" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serveScim(request, {
    store: supabaseScimStore(service),
    admin: supabaseAuthAdmin(service),
    basePath: "/functions/v1/scim/v2",
  });
});
