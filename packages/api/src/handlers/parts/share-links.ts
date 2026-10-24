/**
 * Share link handlers (A82, migration 1380, Section 8.6): list, get, create and revoke. Every call
 * runs as the caller: the share link policy shows links of files the caller can read, and
 * app.create_share_link and app.revoke_share_link apply the classification rules. The token and the
 * access code are answered once, by create; reads never carry them.
 */
import type { Components } from "../../contract/operations.generated.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { rpc, run, tableResource } from "../support/table.ts";

const shareLinks = tableResource("shareLinks", { verbs: ["list", "get"] });

export const shareLinkHandlers: HandlerSet<"Platform"> = {
  ...(shareLinks.handlers as unknown as HandlerSet<"Platform">),
  "shareLinks.create": async ({ body }, context) => {
    const rows = await run<
      {
        share_link_id: string;
        token: string;
        access_code: string | null;
        classification: Components["ShareLinkToken"]["classification"];
        expires_at: string | null;
      }[]
    >(
      rpc(context.db, "create_share_link", {
        p_attachment_id: body.attachment_id,
        p_access_code_required: body.access_code_required ?? false,
        ...((body.expires_at ?? null) === null ? {} : { p_expires_at: body.expires_at }),
        ...((body.recipient_email ?? null) === null
          ? {}
          : { p_recipient_email: body.recipient_email }),
        ...((body.note ?? null) === null ? {} : { p_note: body.note }),
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("create_share_link returned no row.");
    return created(row as Components["ShareLinkToken"]);
  },
  "shareLinks.revoke": async ({ params }, context) => {
    await shareLinks.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "revoke_share_link", { p_share_link_id: params.id }));
    return ok((await shareLinks.read(context, String(params.id))) as Components["ShareLink"]);
  },
};
