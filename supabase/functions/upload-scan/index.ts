// Upload scan worker (A22-011, owner decision 10, ADR 0034): claims due attachment.scan jobs and object
// scans, checks each file's bytes against its declared type, scans it with self-hosted ClamAV (clamd over
// TCP at XOS_CLAMAV_HOST and XOS_CLAMAV_PORT) and records the verdict, so files leave quarantine only
// once Clean. Files for the public buckets profile-media and org-brand wait in the private upload-staging
// bucket; one that scans Clean is published to its public bucket and removed from staging, one that does
// not is removed and never published (migration 1265, ADR 0034 amendment). Called on a schedule with the
// service key, like webhook-dispatch.
//
// Without XOS_CLAMAV_HOST: on a local stack a logged pass-through marks files clean; anywhere else the
// function claims nothing and answers 503, so files stay quarantined until a scanner is configured.
import { createClient } from "@supabase/supabase-js";
import {
  runUploadScans,
  scanStore,
  selectVirusScanner,
  supabaseStorage,
  type ClamdConnection,
} from "../_vendor/upload-scan.js";
import { createLogger, identityFromEnv } from "../_vendor/core.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

/** A clamd connection over Deno TCP that reads until the NUL byte that ends clamd's reply. */
async function connectClamd(hostname: string, port: number): Promise<ClamdConnection> {
  const conn = await Deno.connect({ hostname, port });
  let closed = false;
  return {
    async write(bytes) {
      let written = 0;
      while (written < bytes.length) written += await conn.write(bytes.subarray(written));
    },
    async readReply() {
      const chunks: Uint8Array[] = [];
      const buffer = new Uint8Array(4096);
      for (;;) {
        const read = await conn.read(buffer);
        if (read === null) break;
        const chunk = buffer.slice(0, read);
        chunks.push(chunk);
        if (chunk.includes(0)) break;
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const reply = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        reply.set(chunk, offset);
        offset += chunk.length;
      }
      return reply;
    },
    close() {
      if (closed) return;
      closed = true;
      conn.close();
    },
  };
}

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const logger = createLogger(identityFromEnv("edge.upload-scan", Deno.env.toObject()));
  const { choice, scanner } = selectVirusScanner({
    env: (name) => Deno.env.get(name),
    connect: connectClamd,
    warn: (message) => logger.warn(message, { scanner: "pass-through" }),
  });
  if (scanner === null) {
    logger.error(choice.reason, { scanner: "none" });
    return json(503, {
      type: "/problems/scanner-not-configured",
      title: "Upload scanner not configured",
      status: 503,
      detail: choice.reason,
    });
  }
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const outcomes = await runUploadScans({
    store: scanStore(serviceDb()),
    storage: supabaseStorage(client),
    scanner,
    worker: `upload-scan:${crypto.randomUUID()}`,
  });
  return json(200, { scanner: choice.kind, scanned: outcomes.length, outcomes });
});
