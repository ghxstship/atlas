"use server";

import {
  acceptRepresentation,
  decideApplication,
  rateEngagement,
  replyToRating,
  revokeProfileShare,
  revokeRepresentation,
  sendMessage,
  sendPartyMessage,
  declineDocument,
  signDocumentText,
  signEngagementDocument,
  submitOnboardingItem,
  type ApplicationState,
} from "@xos/data/gateway";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions for engagement work that a single button runs. Each takes ids the page bound,
 * validates them, and lets the database decide: the A28 RPCs and policies refuse anything the
 * person may not do, and the refusal comes back as catalog copy.
 */
const id = z.uuid();

export async function signDocumentAction(documentId: string): Promise<ActionResult> {
  return toAction(await signEngagementDocument(await createServerSupabase(), id.parse(documentId)));
}

export async function submitOnboardingItemAction(itemId: string): Promise<ActionResult> {
  return toAction(await submitOnboardingItem(await createServerSupabase(), id.parse(itemId)));
}

export async function acceptRepresentationAction(representationId: string): Promise<ActionResult> {
  return toAction(
    await acceptRepresentation(await createServerSupabase(), id.parse(representationId)),
  );
}

export async function revokeRepresentationAction(representationId: string): Promise<ActionResult> {
  return toAction(
    await revokeRepresentation(await createServerSupabase(), id.parse(representationId)),
  );
}

export async function revokeProfileShareAction(shareId: string): Promise<ActionResult> {
  return toAction(await revokeProfileShare(await createServerSupabase(), id.parse(shareId)));
}

const DECISIONS = {
  Withdrawn: "Withdrawn.",
  Accepted: "Offer accepted.",
  Declined: "Offer declined.",
} as const;

export async function decideApplicationAction(
  applicationId: string,
  expected: ApplicationState,
  next: keyof typeof DECISIONS,
): Promise<ActionResult> {
  const parsedNext = z.enum(["Withdrawn", "Accepted", "Declined"]).parse(next);
  return toAction(
    await decideApplication(await createServerSupabase(), {
      applicationId: id.parse(applicationId),
      expected,
      next: parsedNext,
      reason: DECISIONS[parsedNext],
    }),
  );
}

export interface MessageFormState {
  readonly outcome?: string;
  readonly sent?: number;
}

export async function sendMessageAction(
  prev: MessageFormState,
  form: FormData,
): Promise<MessageFormState> {
  const threadId = id.safeParse(form.get("threadId"));
  const body = z.string().trim().min(1).max(4000).safeParse(form.get("body"));
  if (!threadId.success || !body.success) return { outcome: "invalid" };
  const db = await createServerSupabase();
  const input = { threadId: threadId.data, body: body.data };
  const result = toAction(
    form.get("kind") === "party" ? await sendPartyMessage(db, input) : await sendMessage(db, input),
  );
  return result.ok ? { sent: (prev.sent ?? 0) + 1 } : { outcome: result.outcome };
}

export interface RatingFormState {
  readonly outcome?: string;
  readonly done?: boolean;
}

export async function rateEngagementAction(
  _: RatingFormState,
  form: FormData,
): Promise<RatingFormState> {
  const parsed = z
    .object({
      engagementId: z.uuid(),
      score: z.coerce.number().int().min(1).max(5),
      comment: z.string().max(2000),
    })
    .safeParse({
      engagementId: form.get("engagementId"),
      score: form.get("score"),
      comment: form.get("comment") ?? "",
    });
  if (!parsed.success) return { outcome: "invalid" };
  const result = toAction(await rateEngagement(await createServerSupabase(), parsed.data));
  return result.ok ? { done: true } : { outcome: result.outcome };
}

export async function replyToRatingAction(
  _: RatingFormState,
  form: FormData,
): Promise<RatingFormState> {
  const parsed = z
    .object({ ratingId: z.uuid(), body: z.string().trim().min(1).max(2000) })
    .safeParse({ ratingId: form.get("ratingId"), body: form.get("body") });
  if (!parsed.success) return { outcome: "invalid" };
  const result = toAction(await replyToRating(await createServerSupabase(), parsed.data));
  return result.ok ? { done: true } : { outcome: result.outcome };
}

/** Reading and signing a generated engagement document (B10, 2994): what the form answers. */
export interface DocumentTextState {
  readonly done?: boolean;
  readonly refusal?: string;
  readonly outcome?: string;
  readonly at?: number;
}

function textDocumentAnswer(
  result: Awaited<ReturnType<typeof signDocumentText>>,
  path: string,
): DocumentTextState {
  if (result.ok) {
    revalidatePath(path);
    return { done: true, at: Date.now() };
  }
  return result.error.kind === "refusal"
    ? { refusal: result.error.rule, at: Date.now() }
    : { outcome: outcomeFor(result.error), at: Date.now() };
}

export async function signDocumentTextAction(
  _: DocumentTextState,
  form: FormData,
): Promise<DocumentTextState> {
  const parsed = z
    .object({
      documentId: id,
      signedName: z.string().trim().min(1).max(200),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      path: z.string().startsWith("/work/"),
    })
    .safeParse({
      documentId: form.get("documentId"),
      signedName: form.get("signedName"),
      sha256: form.get("sha256"),
      path: form.get("path"),
    });
  if (!parsed.success) return { refusal: "document_signer_name", at: Date.now() };
  const result = await signDocumentText(await createServerSupabase(), {
    documentId: parsed.data.documentId,
    signedName: parsed.data.signedName,
    bodySha256: parsed.data.sha256,
  });
  return textDocumentAnswer(result, parsed.data.path);
}

export async function declineDocumentTextAction(
  _: DocumentTextState,
  form: FormData,
): Promise<DocumentTextState> {
  const parsed = z
    .object({
      documentId: id,
      reason: z.string().trim().min(1).max(450),
      path: z.string().startsWith("/work/"),
    })
    .safeParse({
      documentId: form.get("documentId"),
      reason: form.get("reason"),
      path: form.get("path"),
    });
  if (!parsed.success) return { refusal: "document_decline_reason", at: Date.now() };
  const result = await declineDocument(await createServerSupabase(), {
    documentId: parsed.data.documentId,
    reason: parsed.data.reason,
  });
  return textDocumentAnswer(result, parsed.data.path);
}
