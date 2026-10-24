// File handover (Section 8.6, finding A65-016; migrations 1380 and 1691). A visitor who opens a share link has no
// session, so api_public.open_share_link answers a single-use download ticket instead of the file; an in-app download
// of a copy that must carry the watermark gets one from app.record_file_download, since the storage policy keeps the
// viewer from reading that object. The web shell POSTs the ticket here; this function consumes it with the service
// role (app.consume_file_download_ticket: once, within 2 minutes, only while the link is not revoked) and answers the
// stored bytes. The ticket is the credential, so the function takes no JWT (verify_jwt = false in config.toml).
//
// A Confidential or Restricted PDF or image must carry the viewer's email and the time (A103, ADR 0061), which the web
// shell stamps before anyone sees the file. Such a copy is answered only to the web shell, which proves itself with
// the handover secret both hold (XOS_FILE_HANDOVER_SECRET, at least 32 characters) as a bearer token; anyone else who
// holds a ticket for it, such as a link's recipient calling the open RPC directly, gets 404 and the ticket stays
// unused. Unset, no such copy is handed over at all. The X-XOS-Watermark header tells the web shell whether the copy
// must carry the mark, by the file's classification at this moment.
import { createClient } from "@supabase/supabase-js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

const TICKET = /^xdlt_[0-9a-f]{64}$/;
/** A shorter value is treated as unset, so a sample or truncated value never opens the handover. */
const HANDOVER_MIN_LENGTH = 32;
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

  const handover = Deno.env.get("XOS_FILE_HANDOVER_SECRET") ?? "";
  const watermarks = handover.length >= HANDOVER_MIN_LENGTH && hasBearer(request, handover);

  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .schema("app")
    .rpc("consume_file_download_ticket", { p_ticket: ticket, p_watermarks: watermarks });
  if (error) throw new Error(`consume_file_download_ticket: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : null) as {
    bucket_id: string;
    object_name: string;
    content_type: string;
    watermark: boolean;
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
      "X-XOS-Watermark": row.watermark ? "required" : "none",
    },
  });
});
