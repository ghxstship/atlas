// Automation worker (A91, RRR-136; ADR 0047, finding A65-010): one pass over the queued automation.run jobs. Each run
// is started by app.begin_automation_run, which fails closed when the owner left the org or lost
// org.automations.write; each action is then a public API call made as the automation's owner with a two-minute token
// (packages/data/src/automation-runner.ts), so row level security and capabilities decide every write. The service
// role only claims jobs and writes the runs ledger. Called every minute with the service key, like webhook-dispatch:
// select cron.schedule('xos_worker_automation_run', '* * * * *', ...) as the self-hosting guide shows.
//
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (provided by Supabase), XOS_API_JWT_SIGNING_KEY (the project's
// JWT secret, which api-token and integration-worker also use) and XOS_APP_URL (Atlas, whose /api/v1 the actions call).
// None of them appears in code or tests.
import { createClient } from "@supabase/supabase-js";
import { runAutomationJobs, supabaseAutomationRunStore } from "../_vendor/automation-run.js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

serve(async (request) => {
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!hasBearer(request, serviceKey)) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const url = env("SUPABASE_URL");
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const results = await runAutomationJobs({
    store: supabaseAutomationRunStore(client),
    fetch: (input, init) => fetch(input, init),
    apiBaseUrl: `${env("XOS_APP_URL").replace(/\/$/, "")}/api/v1`,
    signingKey: env("XOS_API_JWT_SIGNING_KEY"),
    issuer: `${url}/auth/v1`,
    worker: `automation-run:${crypto.randomUUID()}`,
  });
  return json(200, { processed: results.length, results });
});
