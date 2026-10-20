"use server";

import type { DataError } from "@xos/data";
import { getSubscription } from "@xos/data";
import { dismissTip, getHelpState, recordTour, resetTips, type TourState } from "@xos/data/help";
import {
  getSupportTicket,
  openSupportTicket,
  SUPPORT_CATEGORIES,
  SUPPORT_SEVERITIES,
  type SupportChannel,
} from "@xos/data/support";
import { myMembershipId } from "@xos/data/views";
import { uploadSupportScreenshot } from "@xos/data/workflow";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { docsUrl } from "@/lib/docs-site";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/shell/context";
import { getShellSettings, type OrgSupport } from "@/lib/shell/org-settings";
import { platformChannel } from "@/lib/support/terms";

/**
 * Server actions behind the help panel (Section 11.16): the person's tours and tips, and opening a
 * support request with consented diagnostics. Every call reads and writes with the viewer's client.
 */

export type HelpActionError = "denied" | "noChannel" | "invalid" | "unexpected";
export type HelpResult<T = null> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: HelpActionError };

const KEY = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/)
  .max(100);

function errorOf(error: DataError): HelpActionError {
  if (error.kind === "refusal") {
    return error.rule === "support_plan_no_channel" ? "noChannel" : "denied";
  }
  if (error.kind === "invalid") return "invalid";
  if (error.kind === "not-found") return "denied";
  return error.kind === "unexpected" && error.code === "42501" ? "denied" : "unexpected";
}

async function context(orgSlug: string) {
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.viewer.person) return null;
  const membership = await myMembershipId(ctx.viewer.db, {
    orgId: ctx.org.id,
    personId: ctx.viewer.person.id,
  });
  if (!membership.ok) return null;
  return { ctx, db: ctx.viewer.db, orgId: ctx.org.id, membershipId: membership.data };
}

export interface HelpPanelState {
  readonly tours: readonly { readonly tourKey: string; readonly state: TourState }[];
  readonly dismissedTips: readonly string[];
  /** The person may contact platform support (org.help.write). */
  readonly canContactPlatform: boolean;
  /** The platform channel of the org's plan; null on the Access plan. */
  readonly platformChannel: SupportChannel | null;
  /** The org's own support contacts (help.support_email, help.support_hours, help.custom_link). */
  readonly orgSupport: OrgSupport | null;
  /** The docs site origin (DOCS_SITE_URL), for help center links; null when unset. */
  readonly docsUrl: string | null;
}

/** The person's tours, dismissed tips and support options in this org. */
export async function loadHelpStateAction(orgSlug: string): Promise<HelpResult<HelpPanelState>> {
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const canContactPlatform = c.ctx.capabilities.has("org.help.write");
  const [state, subscription, settings] = await Promise.all([
    getHelpState(c.db, c.membershipId),
    canContactPlatform ? getSubscription(c.db, c.orgId) : null,
    getShellSettings(c.db, c.orgId, null),
  ]);
  if (!state.ok) return { ok: false, error: errorOf(state.error) };
  if (subscription && !subscription.ok && subscription.error.kind !== "not-found") {
    return { ok: false, error: errorOf(subscription.error) };
  }
  return {
    ok: true,
    data: {
      tours: state.data.tours.map((t) => ({ tourKey: t.tourKey, state: t.state })),
      dismissedTips: state.data.dismissedTips,
      canContactPlatform,
      platformChannel: platformChannel(subscription?.ok ? subscription.data.planCode : null),
      orgSupport: settings.support,
      docsUrl: docsUrl(env()),
    },
  };
}

/** Records a tour being offered, started, finished or dismissed. */
export async function recordTourAction(
  orgSlug: string,
  tourKey: string,
  state: TourState,
  step = 0,
): Promise<HelpResult> {
  const parsed = z
    .object({
      key: KEY,
      state: z.enum(["Offered", "Started", "Completed", "Dismissed"]),
      step: z.number().int().min(0).max(50),
    })
    .safeParse({ key: tourKey, state, step });
  if (!parsed.success) return { ok: false, error: "invalid" };
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const result = await recordTour(c.db, {
    orgId: c.orgId,
    membershipId: c.membershipId,
    tourKey,
    state,
    step,
  });
  return result.ok ? { ok: true, data: null } : { ok: false, error: errorOf(result.error) };
}

/** Dismisses a contextual tip for good. */
export async function dismissTipAction(orgSlug: string, tipKey: string): Promise<HelpResult> {
  if (!KEY.safeParse(tipKey).success) return { ok: false, error: "invalid" };
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const result = await dismissTip(c.db, { orgId: c.orgId, membershipId: c.membershipId, tipKey });
  return result.ok ? { ok: true, data: null } : { ok: false, error: errorOf(result.error) };
}

/** Shows every tip again. */
export async function resetTipsAction(orgSlug: string): Promise<HelpResult> {
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const result = await resetTips(c.db, c.membershipId);
  if (!result.ok) return { ok: false, error: errorOf(result.error) };
  revalidatePath(`/${orgSlug}/me/preferences`);
  return { ok: true, data: null };
}

const supportShape = z.object({
  queue: z.enum(["Organization", "Platform"]),
  category: z.enum(SUPPORT_CATEGORIES as [string, ...string[]]),
  severity: z.enum(SUPPORT_SEVERITIES as [string, ...string[]]),
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
export type SupportRequestInput = z.input<typeof supportShape>;

/**
 * Uploads a screenshot for a support request (A33, bucket support-screenshots): private to the
 * uploader and the platform's support staff. Returns the path to send with the diagnostics.
 */
export async function uploadSupportScreenshotAction(
  orgSlug: string,
  form: FormData,
): Promise<HelpResult<{ readonly path: string }>> {
  const file = form.get("screenshot");
  if (!(file instanceof Blob) || file.size === 0) return { ok: false, error: "invalid" };
  const c = await context(orgSlug);
  if (!c?.ctx.viewer.person) return { ok: false, error: "denied" };
  const result = await uploadSupportScreenshot(c.db, { personId: c.ctx.viewer.person.id, file });
  return result.ok
    ? { ok: true, data: { path: result.data } }
    : { ok: false, error: errorOf(result.error) };
}

/** Opens a support request; diagnostics are sent only when the person ticked the consent box. */
export async function openSupportRequestAction(
  orgSlug: string,
  input: SupportRequestInput,
): Promise<HelpResult<{ readonly id: string; readonly number: string | null }>> {
  const parsed = supportShape.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const d = parsed.data;
  const result = await openSupportTicket(c.db, {
    orgId: c.orgId,
    queue: d.queue,
    category: d.category as (typeof SUPPORT_CATEGORIES)[number],
    severity: d.severity as (typeof SUPPORT_SEVERITIES)[number],
    subject: d.subject,
    body: d.body,
    diagnostics: d.diagnostics,
  });
  if (!result.ok) return { ok: false, error: errorOf(result.error) };
  const ticket = await getSupportTicket(c.db, result.data);
  revalidatePath(`/${orgSlug}/me/account`);
  revalidatePath(`/${orgSlug}/settings/help-and-support`);
  return { ok: true, data: { id: result.data, number: ticket.ok ? ticket.data.number : null } };
}
