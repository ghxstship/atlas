"use server";

import {
  calendarFeedUrl,
  createCalendarFeed,
  revokeCalendarFeed,
  rotateCalendarFeed,
} from "@xos/data/calendar-feeds";
import type { DataError, Result } from "@xos/data/result";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Personal settings, Calendar Feeds (Section 4.6.5, ADR 0040): add a feed of the member's own
 * schedule or of a project, get a new link, revoke. The token comes back once, as the full
 * subscription link on Atlas's origin; nothing stores it. Row level security and the 1410 RPCs
 * decide every write.
 */

export interface CalendarFeedFormState {
  readonly ok?: boolean;
  readonly error?: string;
  /** The subscription link, shown once after adding a feed or getting a new link. */
  readonly link?: string;
}

const KNOWN_RULES = new Set(["calendar_feed_limit", "calendar_feed_revoked"]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_RULES.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

/** A feed result: a new token for create and rotate, nothing for revoke. */
function finish(slug: string, result: Result<unknown>): CalendarFeedFormState {
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${slug}/me/calendar-feeds`);
  const token = (result.data as { token?: unknown } | undefined)?.token;
  return typeof token === "string"
    ? { ok: true, link: calendarFeedUrl(env().ATLAS_SITE_URL, token) }
    : { ok: true };
}

const scope = z.union([z.literal("mine"), z.uuid()]);
const id = z.uuid();

export async function addCalendarFeedAction(
  _: CalendarFeedFormState,
  form: FormData,
): Promise<CalendarFeedFormState> {
  const ctx = await contextFor(form);
  const parsed = scope.safeParse(form.get("scope"));
  if (!parsed.success) return { error: "invalid" };
  const projectId = parsed.data === "mine" ? null : parsed.data;
  return finish(ctx.org.slug, await createCalendarFeed(ctx.viewer.db, ctx.org.id, projectId));
}

export async function rotateCalendarFeedAction(
  _: CalendarFeedFormState,
  form: FormData,
): Promise<CalendarFeedFormState> {
  const ctx = await contextFor(form);
  const parsed = id.safeParse(form.get("id"));
  if (!parsed.success) return { error: "denied" };
  return finish(ctx.org.slug, await rotateCalendarFeed(ctx.viewer.db, parsed.data));
}

export async function revokeCalendarFeedAction(
  _: CalendarFeedFormState,
  form: FormData,
): Promise<CalendarFeedFormState> {
  const ctx = await contextFor(form);
  const parsed = id.safeParse(form.get("id"));
  if (!parsed.success) return { error: "denied" };
  return finish(ctx.org.slug, await revokeCalendarFeed(ctx.viewer.db, parsed.data));
}
