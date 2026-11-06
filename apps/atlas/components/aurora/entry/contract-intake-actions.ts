"use server";

import { uploadAttachment, uploadRestrictedAttachment } from "@xos/data/attachments";
import { z } from "zod";
import { actionContext } from "@/lib/collection-kit/actions";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Attaches a file of a contract review to its engagement document (B15, ADR 0154). A contract's file
 * carries the fee, so it is raised to Restricted, and if that fails the attachment is removed. A
 * rider's file keeps the default classification.
 */
export async function attachContractFileAction(form: FormData): Promise<{ readonly ok: boolean }> {
  const ctx = await actionContext(form);
  const id = z.uuid().safeParse(form.get("engagementDocumentId"));
  const file = form.get("file");
  if (!id.success || !(file instanceof File) || file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
    return { ok: false };
  }
  const input = {
    subject: { table: "app.engagement_documents", id: id.data },
    file,
    filename: file.name,
  };
  const uploaded =
    form.get("documentType") === "Contract"
      ? await uploadRestrictedAttachment(ctx.viewer.db, input)
      : await uploadAttachment(ctx.viewer.db, input);
  return { ok: uploaded.ok };
}
