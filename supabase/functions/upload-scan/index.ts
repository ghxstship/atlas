// Upload scan worker (A22-011): claims due attachment.scan jobs and object scans, checks each file's
// bytes against its declared type, scans it with ClamAV (clamd over TCP at CLAMD_HOST and CLAMD_PORT)
// and records the verdict, so attachments reach Clean and unscanned files are never served to others.
// Called on a schedule with the service key, like webhook-dispatch.
import { createClient } from "@supabase/supabase-js";
import {
  clamavScanner,
  runUploadScans,
  scanStore,
  supabaseStorage,
  type ClamdConnection,
} from "../_vendor/xos-platform.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

/** A clamd connection over Deno TCP that reads until the NUL byte that ends clamd's reply. */
async function connectClamd(hostname: string, port: number): Promise<ClamdConnection> {
  const conn = await Deno.connect({ hostname, port });
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
      conn.close();
    },
  };
}

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const hostname = env("CLAMD_HOST");
  const port = Number(env("CLAMD_PORT"));
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const outcomes = await runUploadScans({
    store: scanStore(serviceDb()),
    storage: supabaseStorage(client),
    scanner: clamavScanner({ connect: () => connectClamd(hostname, port) }),
    worker: `upload-scan:${crypto.randomUUID()}`,
  });
  return json(200, { scanned: outcomes.length, outcomes });
});
