"use server";

import {
  partyUploadObjectName,
  submitTypedAdvanceAnswer,
  uploadPartyFile,
  type PartyUploadTarget,
} from "@xos/data/gateway";
import { resubmitSponsorAsset, supplySponsorAsset } from "@xos/data/sponsor-assets";
import { APP_ENUMS } from "@xos/data/gateway";
import { createHash } from "node:crypto";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import type { FormResult } from "@/lib/actions/operations";
import { answerHead, answerHeadOf, answerLines, formFiles } from "@/lib/advance-answer-form";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Typed advance answers and party uploads in Gateway (R9, migrations 2711 to 2713). Files go to the
 * party-uploads bucket under the recipient and section (or the sponsor entitlement), are registered as
 * documents, and are attached to the answer or the supplied asset in the same request; the scan worker
 * clears them before anyone but the uploader can read them. The database decides who may answer and
 * refuses with a named rule; these actions only shape the input and keep the type and 25 MB checks of
 * the onboarding upload (operations.ts).
 */

const id = z.uuid();

/** Uploads and registers each file under the target folder; the document ids, or the failure. */
async function uploadAll(
  orgId: string,
  target: PartyUploadTarget,
  files: readonly File[],
): Promise<{ ok: true; ids: string[] } | { ok: false; result: FormResult }> {
  const db = await createServerSupabase();
  const ids: string[] = [];
  for (const file of files) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const uploaded = await uploadPartyFile(db, {
      objectName: partyUploadObjectName({ orgId, target, fileName: file.name }),
      title: file.name.slice(0, 200) || "Upload",
      body: new Blob([bytes], { type: file.type }),
      contentType: file.type,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (!uploaded.ok) return { ok: false, result: { outcome: outcomeFor(uploaded.error) } };
    ids.push(uploaded.data.documentId);
  }
  return { ok: true, ids };
}

/** A File section's answer: the uploaded files, attached to one answer with an optional note. */
export async function uploadAdvanceFileAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({ orgId: id, recipientId: id, sectionId: id, note: z.string().trim().max(2000) })
    .safeParse({
      orgId: form.get("orgId"),
      recipientId: form.get("recipientId"),
      sectionId: form.get("sectionId"),
      note: form.get("note") ?? "",
    });
  if (!parsed.success) return { fieldError: "file" };
  const files = formFiles(form);
  if (!Array.isArray(files)) return files;
  const f = parsed.data;
  const uploaded = await uploadAll(
    f.orgId,
    { kind: "advance", recipientId: f.recipientId, sectionId: f.sectionId },
    files,
  );
  if (!uploaded.ok) return uploaded.result;
  const result = await submitTypedAdvanceAnswer(await createServerSupabase(), {
    recipientId: f.recipientId,
    sectionId: f.sectionId,
    note: f.note === "" ? null : f.note,
    documentIds: uploaded.ids,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

/**
 * A Schedule Window, Item Request, Credential Request or Guest List answer. Lines arrive as
 * line.<n>.<field>; an item is asset_class:<id> or credential_category:<id>, times are local in the
 * form's zone and become instants here.
 */
export async function submitTypedAdvanceAction(_: FormResult, form: FormData): Promise<FormResult> {
  const head = answerHead.extend({ recipientId: id, sectionId: id }).safeParse({
    recipientId: form.get("recipientId"),
    sectionId: form.get("sectionId"),
    ...answerHeadOf(form),
  });
  if (!head.success) return { fieldError: "answer" };
  const h = head.data;
  const lines = answerLines(form, h.lines, h.timeZone);
  if (!Array.isArray(lines)) return lines;
  const result = await submitTypedAdvanceAnswer(await createServerSupabase(), {
    recipientId: h.recipientId,
    sectionId: h.sectionId,
    note: h.note === "" ? null : h.note,
    lines,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

/** The sponsor supplies a brand asset with its files (app.supply_sponsor_asset). */
export async function supplySponsorAssetAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({
      orgId: id,
      entitlementId: id,
      kind: z.enum(APP_ENUMS.sponsor_asset_kind),
      title: z.string().trim().min(1).max(200),
      usageNote: z.string().trim().max(1000),
      dueOn: z.union([z.literal(""), z.iso.date()]),
    })
    .safeParse({
      orgId: form.get("orgId"),
      entitlementId: form.get("entitlementId"),
      kind: form.get("kind"),
      title: form.get("title") ?? "",
      usageNote: form.get("usageNote") ?? "",
      dueOn: form.get("dueOn") ?? "",
    });
  if (!parsed.success)
    return { fieldError: parsed.error.issues[0]?.path[0] === "title" ? "title" : "sponsorAsset" };
  const files = formFiles(form);
  if (!Array.isArray(files)) return files;
  const f = parsed.data;
  const uploaded = await uploadAll(
    f.orgId,
    { kind: "sponsor-asset", entitlementId: f.entitlementId },
    files,
  );
  if (!uploaded.ok) return uploaded.result;
  const result = await supplySponsorAsset(await createServerSupabase(), {
    entitlementId: f.entitlementId,
    kind: f.kind,
    title: f.title,
    usageNote: f.usageNote === "" ? null : f.usageNote,
    dueOn: f.dueOn === "" ? null : f.dueOn,
    documentIds: uploaded.ids,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

/** The sponsor resubmits a returned asset it supplied, with new files (app.resubmit_sponsor_asset). */
export async function resubmitSponsorAssetAction(
  _: FormResult,
  form: FormData,
): Promise<FormResult> {
  const parsed = z
    .object({ orgId: id, entitlementId: id, assetId: id, reason: z.string().trim().max(500) })
    .safeParse({
      orgId: form.get("orgId"),
      entitlementId: form.get("entitlementId"),
      assetId: form.get("assetId"),
      reason: form.get("reason") ?? "",
    });
  if (!parsed.success) return { fieldError: "sponsorAsset" };
  const files = formFiles(form);
  if (!Array.isArray(files)) return files;
  const f = parsed.data;
  const uploaded = await uploadAll(
    f.orgId,
    { kind: "sponsor-asset", entitlementId: f.entitlementId },
    files,
  );
  if (!uploaded.ok) return uploaded.result;
  const result = await resubmitSponsorAsset(await createServerSupabase(), {
    assetId: f.assetId,
    documentIds: uploaded.ids,
    reason: f.reason === "" ? null : f.reason,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}
