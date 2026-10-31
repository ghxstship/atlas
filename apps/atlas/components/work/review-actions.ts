"use server";

import { reviewAttachmentVersion, type FileReviewDecision } from "@xos/data/attachments";
import { decideRecordReview, requestRecordReview, type ReviewDecision } from "@xos/data/work";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { done, failed, invalid, type ActionResult } from "./action-result";

/**
 * Reviews (B14, G-268, migrations 3034 and 3035): asking for and deciding a record's review, and reviewing a version of
 * a file on a submittal or a record. The RPCs decide every rule (separation of duties, eligibility, the notes asked
 * for), and their refusals come back as catalog keys under `work.errors.rules`.
 */

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

const note = z.string().trim().max(1000).nullable();

export async function requestReviewAction(
  org: string,
  input: {
    readonly recordId: string;
    readonly reviewerId: string | null;
    readonly note: string | null;
  },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({ recordId: z.uuid(), reviewerId: z.uuid().nullable(), note })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await requestRecordReview(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}

export async function decideReviewAction(
  org: string,
  input: {
    readonly approvalRecordId: string;
    readonly decision: ReviewDecision;
    readonly note: string | null;
  },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({ approvalRecordId: z.uuid(), decision: z.enum(["Approved", "Rejected"]), note })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await decideRecordReview(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}

export async function reviewFileVersionAction(
  org: string,
  input: {
    readonly versionId: string;
    readonly decision: FileReviewDecision;
    readonly note: string | null;
  },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({ versionId: z.uuid(), decision: z.enum(["Approved", "Changes Requested"]), note })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await reviewAttachmentVersion(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}
