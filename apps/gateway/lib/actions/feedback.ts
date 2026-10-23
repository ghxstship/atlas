"use server";

import { feedbackRoute, sendFeedback } from "@xos/data/feedback";
import { z } from "zod";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Send Feedback in the Gateway help panel (Section 11.7, A96, migration 1531): the message, the page context the
 * widget showed and an optional screenshot the person uploaded (uploadAccountSupportScreenshotAction, 1034). Gateway
 * names no org: feedback goes to the platform team about the product.
 */

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
export type GatewayFeedbackInput = z.input<typeof feedbackShape>;

export type GatewayFeedbackResult =
  | { readonly ok: true; readonly number: string }
  | { readonly ok: false; readonly error: "limit" | "invalid" | "failed" };

export async function sendFeedbackAction(
  input: GatewayFeedbackInput,
): Promise<GatewayFeedbackResult> {
  const parsed = feedbackShape.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const ctx = await getGatewayContext();
  if (!ctx) return { ok: false, error: "failed" };
  const d = parsed.data;
  const result = await sendFeedback(ctx.db, {
    app: "Gateway",
    message: d.message,
    route: feedbackRoute(d.route),
    orgId: null,
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
