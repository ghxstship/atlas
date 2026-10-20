"use server";

import type { DataError } from "@xos/data";
import { ACCOUNT_SUPPORT_CATEGORIES, openAccountSupportRequest } from "@xos/data/support";
import { uploadSupportScreenshot } from "@xos/data/workflow";
import { z } from "zod";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Contact Support in the Gateway help panel (Section 11.16): a request to platform support about the
 * person's own account (migration 1300), with diagnostics only when they consent. Questions about
 * work go to the organization in Messages, so nothing here reaches an org.
 */

export type SupportError = "denied" | "invalid" | "limit" | "category" | "unexpected";
export type SupportResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SupportError };

function errorOf(error: DataError): SupportError {
  if (error.kind === "refusal") {
    if (error.rule === "account_support_limit") return "limit";
    if (error.rule === "account_support_category") return "category";
    return "invalid";
  }
  if (error.kind === "invalid") return "invalid";
  if (error.kind === "unexpected" && error.code === "42501") return "denied";
  if (error.kind === "unexpected") console.error("Account support request failed", error);
  return error.kind === "not-found" ? "denied" : "unexpected";
}

const requestShape = z.object({
  category: z.enum(ACCOUNT_SUPPORT_CATEGORIES),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  diagnostics: z
    .object({
      route: z.string().max(500).nullable(),
      appVersion: z.string().max(50).nullable(),
      device: z.string().max(300).nullable(),
      recentErrors: z.string().max(4000).nullable(),
      screenshotPath: z
        .string()
        .regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/)
        .nullable()
        .default(null),
    })
    .nullable(),
});
export type AccountSupportInput = z.input<typeof requestShape>;

/**
 * Uploads a screenshot for the request to the person's own support-screenshots folder (A33), which
 * only they and platform support read. Returns the path to send with the diagnostics.
 */
export async function uploadAccountSupportScreenshotAction(
  form: FormData,
): Promise<SupportResult<{ readonly path: string }>> {
  const file = form.get("screenshot");
  if (!(file instanceof Blob) || file.size === 0) return { ok: false, error: "invalid" };
  const ctx = await getGatewayContext();
  if (!ctx) return { ok: false, error: "denied" };
  const result = await uploadSupportScreenshot(ctx.db, { personId: ctx.personId, file });
  return result.ok
    ? { ok: true, data: { path: result.data } }
    : { ok: false, error: errorOf(result.error) };
}

/** Sends the request; platform support answers by email at the sign-in address it returns. */
export async function openAccountSupportRequestAction(
  input: AccountSupportInput,
): Promise<SupportResult<{ readonly number: string; readonly email: string }>> {
  const parsed = requestShape.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const ctx = await getGatewayContext();
  if (!ctx) return { ok: false, error: "denied" };
  const result = await openAccountSupportRequest(ctx.db, parsed.data);
  return result.ok
    ? { ok: true, data: { number: result.data, email: ctx.email ?? "" } }
    : { ok: false, error: errorOf(result.error) };
}
