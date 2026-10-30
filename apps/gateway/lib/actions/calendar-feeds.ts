"use server";

import {
  CALENDAR_FEED_SOURCES,
  calendarFeedUrl,
  configurePersonCalendarFeed,
  createPersonCalendarFeed,
  DEFAULT_FEED_SOURCES,
  revokePersonCalendarFeed,
  rotatePersonCalendarFeed,
  type PersonFeedConfiguration,
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
 * 1410 RPCs limit every write to the person's own feeds. A feed has a name and content, cues
 * included, set when it is added or with Edit (B7, ADR 0146); the 2961 RPCs refuse a bad one.
 */

export interface PersonFeedFormState {
  readonly ok?: boolean;
  readonly error?: string;
  /** The subscription link, shown once after adding a feed or getting a new link. */
  readonly link?: string;
}

const KNOWN_RULES = new Set(["calendar_feed_limit", "calendar_feed_name", "calendar_feed_sources"]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal" && KNOWN_RULES.has(error.rule)) return error.rule;
  if (error.kind === "not-found") return "denied";
  return "unexpected";
}

const source = z.enum(CALENDAR_FEED_SOURCES);

/**
 * A personal feed's name and content from the form. The four 4.0 sources alone are saved as the
 * default (null); none checked is sent as an empty list, which the RPC refuses.
 */
function configurationFrom(form: FormData): PersonFeedConfiguration | null {
  const parsed = form.getAll("sources").map((v) => source.safeParse(v));
  if (parsed.some((p) => !p.success)) return null;
  const picked = new Set(parsed.flatMap((p) => (p.success ? [p.data] : [])));
  const sources = CALENDAR_FEED_SOURCES.filter((s) => picked.has(s));
  const isDefault =
    sources.length === DEFAULT_FEED_SOURCES.length &&
    DEFAULT_FEED_SOURCES.every((s) => picked.has(s));
  const name = form.get("name");
  return { name: typeof name === "string" ? name : null, sources: isDefault ? null : sources };
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

/** Adds a feed with its name and content; useActionState passes the previous state, which adding does not need. */
export async function addPersonFeedAction(
  _: PersonFeedFormState,
  form: FormData,
): Promise<PersonFeedFormState> {
  const config = configurationFrom(form);
  if (config === null) return { error: "unexpected" };
  return finish(await createPersonCalendarFeed(await database(), config));
}

/** Edit: replaces a feed's name and content; its link stays. */
export async function configurePersonFeedAction(
  _: PersonFeedFormState,
  form: FormData,
): Promise<PersonFeedFormState> {
  const parsed = id.safeParse(form.get("id"));
  if (!parsed.success) return { error: "denied" };
  const config = configurationFrom(form);
  if (config === null) return { error: "unexpected" };
  return finish(await configurePersonCalendarFeed(await database(), parsed.data, config));
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
