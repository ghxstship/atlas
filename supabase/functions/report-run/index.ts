// Report run worker (A35, RRR-79): claims due report.run jobs, reads each run's rows as the person it
// runs for (migration 1050, app.report_run_rows), aggregates them as the report builder preview does,
// stores the CSV in the private report-results bucket and records the outcome. Called on a schedule
// with the service key, like webhook-dispatch and upload-scan.
import { createClient } from "@supabase/supabase-js";
import {
  reportRunLabels,
  runReportJobs,
  supabaseReportRunStore,
  supabaseResultStorage,
} from "../_vendor/xos-platform.js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const results = await runReportJobs({
    store: supabaseReportRunStore(client),
    storage: supabaseResultStorage(client),
    labels: reportRunLabels("en-US"),
    worker: `report-run:${crypto.randomUUID()}`,
  });
  return json(200, { processed: results.length, results });
});
