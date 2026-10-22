"use server";

import {
  classifyAttachment,
  createShareLink,
  isClassification,
  listShareLinks,
  revokeShareLink,
  type DataClassification,
  type ShareLink,
} from "@xos/data/share-links";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Share links and file classification from a file's row (Section 8.6, finding A65-016; migration
 * 1380). Each action runs as the signed-in person in the org named by the slug; the database applies
 * every rule (who may classify, which files may be shared, expiry, access codes, recipients) and the
 * actions only report its refusals by rule.
 */

export type ShareActionResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

function refused(error: { kind: string; rule?: string }): { ok: false; error: string } {
  if (error.kind === "refusal" && error.rule) return { ok: false, error: error.rule };
  return { ok: false, error: error.kind === "not-found" ? "notFound" : "unexpected" };
}

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) return null;
  return ctx;
}

/** The file's links, newest first, for the share panel. */
export async function loadShareLinksAction(
  org: string,
  attachmentId: string,
): Promise<ShareActionResult<readonly ShareLink[]>> {
  const ctx = await context(org);
  const id = z.uuid().safeParse(attachmentId);
  if (!ctx || !id.success) return { ok: false, error: "notFound" };
  const links = await listShareLinks(ctx.viewer.db, id.data);
  return links.ok ? { ok: true, data: links.data } : refused(links.error);
}

/** Raises or lowers a file's classification. */
export async function classifyFileAction(
  org: string,
  attachmentId: string,
  classification: string,
): Promise<ShareActionResult<DataClassification>> {
  const ctx = await context(org);
  const id = z.uuid().safeParse(attachmentId);
  if (!ctx || !id.success || !isClassification(classification)) {
    return { ok: false, error: "notFound" };
  }
  const saved = await classifyAttachment(ctx.viewer.db, id.data, classification);
  if (!saved.ok) return refused(saved.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, data: saved.data };
}

const createSchema = z.object({
  attachmentId: z.uuid(),
  /** A calendar day; the link expires at the end of it in UTC. Empty for a Public file's open link. */
  expiresOn: z.union([z.literal(""), z.iso.date()]),
  accessCode: z.boolean(),
  recipientEmail: z.union([z.literal(""), z.email().max(320)]),
  note: z.string().trim().max(200),
});

export interface CreatedLink {
  readonly url: string;
  readonly accessCode: string | null;
  readonly link: ShareLink;
}

/** Makes a link and returns its address and code once. */
export async function createShareLinkAction(
  org: string,
  input: z.input<typeof createSchema>,
): Promise<ShareActionResult<CreatedLink>> {
  const ctx = await context(org);
  const parsed = createSchema.safeParse(input);
  if (!ctx) return { ok: false, error: "notFound" };
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return {
      ok: false,
      error: field === "recipientEmail" ? "share_link_recipient_format" : "share_link_expiry_range",
    };
  }
  const p = parsed.data;
  const created = await createShareLink(ctx.viewer.db, {
    attachmentId: p.attachmentId,
    expiresAt: p.expiresOn === "" ? null : `${p.expiresOn}T23:59:59Z`,
    accessCodeRequired: p.accessCode,
    recipientEmail: p.recipientEmail === "" ? null : p.recipientEmail,
    note: p.note === "" ? null : p.note,
  });
  if (!created.ok) return refused(created.error);
  const links = await listShareLinks(ctx.viewer.db, p.attachmentId);
  const link = links.ok ? links.data.find((l) => l.id === created.data.id) : undefined;
  if (!link) return { ok: false, error: "unexpected" };
  return {
    ok: true,
    data: {
      url: new URL(`/share/${created.data.token}`, env().ATLAS_SITE_URL).toString(),
      accessCode: created.data.accessCode,
      link,
    },
  };
}

/** Revokes a link. */
export async function revokeShareLinkAction(
  org: string,
  shareLinkId: string,
): Promise<ShareActionResult<string>> {
  const ctx = await context(org);
  const id = z.uuid().safeParse(shareLinkId);
  if (!ctx || !id.success) return { ok: false, error: "notFound" };
  const revoked = await revokeShareLink(ctx.viewer.db, id.data);
  return revoked.ok ? { ok: true, data: revoked.data } : refused(revoked.error);
}
