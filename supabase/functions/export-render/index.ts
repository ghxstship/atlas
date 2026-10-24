// Export worker (A102, RRR-146; migration 1680): claims export.render jobs, reads each export's rows as the
// person who asked for it (app.export_job_rows), writes the CSV, .xlsx or PDF to the private export-files bucket
// with a 7-day download, watermarks every page of a Confidential or Restricted PDF with the requester's email
// and the time (Section 8.6), records the outcome, and removes the files whose download expired. pg_cron calls
// it every minute while there is work (private.request_export_render), with the service key from Vault.
//
// Read replica (Section 5.1, A65-032): with XOS_READ_REPLICA_URL set to a Supabase read replica's API origin,
// each export's rows are read there, falling back to the primary when the replica errors or lags. Claims,
// export state and storage stay on the primary.
//
// exceljs and pdfkit load only when an export needs them (A85), and the file copy loads per locale on first use.
import { createClient } from "@supabase/supabase-js";
import {
  exportFileCopy,
  readReplicaUrl,
  runExportRenders,
  supabaseExportFiles,
  supabaseExportRenderStore,
} from "../_vendor/export-render.js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), options);
  const replicaUrl = readReplicaUrl(Deno.env.toObject(), (message) => console.warn(message));
  const replica =
    replicaUrl === null
      ? null
      : createClient(replicaUrl, env("SUPABASE_SERVICE_ROLE_KEY"), options);
  const outcome = await runExportRenders({
    store: supabaseExportRenderStore(client, {
      replica,
      onReplicaFallback: (label, reason) =>
        console.warn(`export-render: ${label} read from the primary (${String(reason)})`),
    }),
    files: supabaseExportFiles(client),
    copy: exportFileCopy,
    worker: `export-render:${crypto.randomUUID()}`,
    warn: (message) => console.warn(message),
  });
  return json(200, {
    processed: outcome.renders.length,
    results: outcome.renders,
    expired: outcome.expired,
  });
});
