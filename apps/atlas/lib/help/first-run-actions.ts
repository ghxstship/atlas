"use server";

import { feedbackRoute, sendFeedback } from "@xos/data/feedback";
import { getMySandbox, openMySandbox } from "@xos/data/sandbox";
import { z } from "zod";
import { getOrgContext, getViewer } from "@/lib/shell/context";

/**
 * Server actions behind the help panel's first-run entries (Section 11.7, A96): the person's practice sandbox
 * (1530) and feedback to the platform team (1531). Every call runs with the viewer's client; the database decides
 * every refusal.
 */

export interface SandboxSummary {
  readonly slug: string;
  readonly expiresAt: string;
}

/** The person's open sandbox, or null. */
export async function mySandboxAction(): Promise<SandboxSummary | null> {
  const viewer = await getViewer();
  if (!viewer?.person) return null;
  const result = await getMySandbox(viewer.db);
  return result.ok && result.data
    ? { slug: result.data.slug, expiresAt: result.data.expiresAt }
    : null;
}

export type OpenSandboxResult =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly error: "removing" | "failed" };

/** Opens the person's sandbox, creating it from the template the first time. */
export async function openSandboxAction(): Promise<OpenSandboxResult> {
  const viewer = await getViewer();
  if (!viewer?.person) return { ok: false, error: "failed" };
  const result = await openMySandbox(viewer.db);
  if (result.ok) return { ok: true, slug: result.data.slug };
  return {
    ok: false,
    error:
      result.error.kind === "refusal" && result.error.rule === "sandbox_removing"
        ? "removing"
        : "failed",
  };
}

const feedbackShape = z.object({
  message: z.string().trim().min(1).max(4000),
  route: z.string().max(500),
  appVersion: z.string().max(50).nullable(),
  locale: z.string().max(35).nullable(),
  viewport: z
    .string()
    .regex(/^[0-9]{2,5}x[0-9]{2,5}$/)
    .nullable(),
  screenshotPath: z
    .string()
    .regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/)
    .nullable(),
});
export type FeedbackFormInput = z.input<typeof feedbackShape>;

export type SendFeedbackResult =
  | { readonly ok: true; readonly number: string }
  | { readonly ok: false; readonly error: "limit" | "invalid" | "failed" };

/** Sends feedback from a page of an org; the org is named only when the person belongs to it. */
export async function sendFeedbackAction(
  orgSlug: string,
  input: FeedbackFormInput,
): Promise<SendFeedbackResult> {
  const parsed = feedbackShape.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const ctx = await getOrgContext(orgSlug);
  const viewer = ctx?.viewer ?? (await getViewer());
  if (!viewer?.person) return { ok: false, error: "failed" };
  const d = parsed.data;
  const result = await sendFeedback(viewer.db, {
    app: "Atlas",
    message: d.message,
    route: feedbackRoute(d.route),
    orgId: ctx?.org.id ?? null,
    appVersion: d.appVersion,
    locale: d.locale,
    viewport: d.viewport,
    screenshotPath: d.screenshotPath,
  });
  if (result.ok) return { ok: true, number: result.data };
  if (result.error.kind === "refusal" && result.error.rule === "feedback_limit")
    return { ok: false, error: "limit" };
  return { ok: false, error: result.error.kind === "invalid" ? "invalid" : "failed" };
}
