"use server";

import {
  confirmSubprocessorNotices,
  setMemberNoticeSubscription,
  subscribeSubprocessorNotices,
  unsubscribeSubprocessorNotices,
} from "@xos/data/subprocessor-notices";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { getOrgContext } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";
import { observability } from "@/lib/observability";

/**
 * Subprocessor List change notices (Section 14.4, finding A65-014; migration 1382). Plain forms on
 * /legal/subprocessors, so they work before any script loads. The emailed confirmation and
 * unsubscribe links open a page with a button; only the button's POST reaches the database, so a mail
 * scanner that fetches the link changes nothing. The confirm and unsubscribe actions end on the page
 * without the token; the subscription form answers in place.
 */

const PAGE = "/legal/subprocessors";

function done(notice: string): never {
  redirect(`${PAGE}?notice=${notice}#notices` as Route);
}

export interface SubscribeState {
  readonly notice?: "subscribed" | "invalid" | "failed";
}

/** The subscription form's answer, shown in place so a refused address keeps what was typed. */
export async function subscribeSubprocessorAction(
  _: SubscribeState,
  form: FormData,
): Promise<SubscribeState> {
  const email = String(form.get("email") ?? "");
  const locale = (await getLocale()) === "es-US" ? "es-US" : "en-US";
  const result = await subscribeSubprocessorNotices(await createServerSupabase(), email, locale);
  if (!result.ok) return { notice: "failed" };
  return { notice: result.data ? "subscribed" : "invalid" };
}

export async function confirmSubprocessorAction(form: FormData): Promise<void> {
  const result = await confirmSubprocessorNotices(
    await createServerSupabase(),
    String(form.get("token") ?? ""),
  );
  done(result.ok && result.data ? "confirmed" : "confirm-failed");
}

export async function unsubscribeSubprocessorAction(form: FormData): Promise<void> {
  const result = await unsubscribeSubprocessorNotices(
    await createServerSupabase(),
    String(form.get("token") ?? ""),
  );
  done(result.ok && result.data ? "unsubscribed" : "unsubscribe-failed");
}

/** Settings, Notifications: an Owner or Admin turns the notices off or back on. */
export async function setMemberNoticeAction(form: FormData): Promise<void> {
  const ctx = await getOrgContext(String(form.get("org") ?? ""));
  if (!ctx) return;
  const result = await setMemberNoticeSubscription(ctx.viewer.db, form.get("subscribed") === "on");
  if (!result.ok)
    observability.logger.error("subprocessor notice preference was not saved", {
      error: result.error,
    });
  revalidatePath(`/${ctx.org.slug}/me/notifications`);
}
