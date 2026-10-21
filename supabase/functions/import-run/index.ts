// Import worker (A36; A83, RRR-128, finding A65-025): runs the import wizard's background steps with the service
// role. import.fetch reads a Google Sheets link through the org's Google Drive connection and saves it to the
// imports bucket for scanning; import.detect reads every sheet of a Clean upload, records each with a proposed
// target and suggests column mappings from saved profiles, the Playbook column map and header similarity;
// import.validate and import.commit check and write the rows (packages/data/src/import-worker.ts). Called every
// minute with the service key, like report-run.
import { createClient } from "@supabase/supabase-js";
import { runImportJobs, supabaseImportStore } from "../_vendor/import-run.js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const results = await runImportJobs(
    supabaseImportStore(client),
    `import-run:${crypto.randomUUID()}`,
    10,
    {
      sheetsFetch: (url, init) =>
        fetch(url, {
          headers: { ...init.headers },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        }),
    },
  );
  return json(200, { processed: results.length, results });
});
