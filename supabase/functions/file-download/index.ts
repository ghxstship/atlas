// File handover for share links (Section 8.6, finding A65-016, migration 1380). A visitor who opens a share link
// has no session, so api_public.open_share_link answers a single-use download ticket instead of the file. The web
// shell POSTs that ticket here; this function consumes it with the service role (app.consume_file_download_ticket:
// once, within 2 minutes, only while the link is not revoked) and answers the stored bytes. The ticket is the only
// credential, so the function takes no JWT (verify_jwt = false in config.toml). Watermarking Confidential PDFs and
// images happens in the web shell (A103, ADR 0061): it stamps each page of a PDF and renders an image through the
// ADR 0031 pipeline before the visitor gets either, and refuses a file that cannot carry the mark.
import { createClient } from "@supabase/supabase-js";
import { env, json, serve } from "../_shared/runtime.ts";

const TICKET = /^xdlt_[0-9a-f]{64}$/;
const notFound = () => json(404, { type: "/problems/not-found", title: "Not found", status: 404 });

serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  }
  let ticket: unknown = null;
  try {
    ticket = ((await request.json()) as { ticket?: unknown } | null)?.ticket ?? null;
  } catch {
    ticket = null;
  }
  if (typeof ticket !== "string" || !TICKET.test(ticket)) return notFound();

  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .schema("app")
    .rpc("consume_file_download_ticket", { p_ticket: ticket });
  if (error) throw new Error(`consume_file_download_ticket: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : null) as {
    bucket_id: string;
    object_name: string;
    content_type: string;
  } | null;
  if (!row) return notFound();

  const file = await client.storage.from(row.bucket_id).download(row.object_name);
  if (file.error || !file.data) return notFound();
  return new Response(file.data, {
    status: 200,
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
