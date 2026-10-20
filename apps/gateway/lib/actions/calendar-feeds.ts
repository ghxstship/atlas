"use server";

import {
  calendarFeedUrl,
  createPersonCalendarFeed,
  revokePersonCalendarFeed,
  rotatePersonCalendarFeed,
} from "@xos/data/calendar-feeds";
import type { DataError, Result } from "@xos/data/result";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { env } from "@/lib/env";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Settings, Calendar Feeds (Section 4.5.8 Work, Upcoming "with a calendar feed"; Section 4.6.5;
 * ADR 0040): the person's own feed across every org they work with. The token comes back once, as
 * the full subscription link on Gateway's origin; nothing stores it. Row level security and the
 * 1410 RPCs limit every write to the person's own feeds.
 */

export interface PersonFeedFormState {
  readonly ok?: boolean;
  readonly error?: string;
  /** The subscription link, shown once after adding a feed or getting a new link. */
  readonly link?: string;
}

function errorKey(error: DataError): string {
  if (error.kind === "refusal" && error.rule === "calendar_feed_limit") return error.rule;
  if (error.kind === "not-found") return "denied";
  return "unexpected";
}

/** A feed result: a new token for create and rotate, nothing for revoke. */
function finish(result: Result<unknown>): PersonFeedFormState {
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath("/settings/calendar-feeds");
  const token = (result.data as { token?: unknown } | undefined)?.token;
  return typeof token === "string"
    ? { ok: true, link: calendarFeedUrl(env().GATEWAY_SITE_URL, token) }
    : { ok: true };
}

const id = z.uuid();

async function database() {
  const ctx = await getGatewayContext();
  if (!ctx) throw new Error("A signed-in person is required.");
  return ctx.db;
}

/** Adds a feed; useActionState passes the previous state, which adding does not need. */
export async function addPersonFeedAction(): Promise<PersonFeedFormState> {
  return finish(await createPersonCalendarFeed(await database()));
}

export async function rotatePersonFeedAction(
  _: PersonFeedFormState,
  form: FormData,
): Promise<PersonFeedFormState> {
  const parsed = id.safeParse(form.get("id"));
  if (!parsed.success) return { error: "denied" };
  return finish(await rotatePersonCalendarFeed(await database(), parsed.data));
}

export async function revokePersonFeedAction(
  _: PersonFeedFormState,
  form: FormData,
): Promise<PersonFeedFormState> {
  const parsed = id.safeParse(form.get("id"));
  if (!parsed.success) return { error: "denied" };
  return finish(await revokePersonCalendarFeed(await database(), parsed.data));
}
