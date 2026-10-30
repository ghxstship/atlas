"use server";

import {
  CALENDAR_FEED_RULES,
  CALENDAR_FEED_SOURCES,
  calendarFeedUrl,
  configureCalendarFeed,
  createCalendarFeed,
  DEFAULT_FEED_SOURCES,
  revokeCalendarFeed,
  rotateCalendarFeed,
  type CalendarFeedSource,
  type FeedConfiguration,
} from "@xos/data/calendar-feeds";
import { CUE_CALL_KINDS, type CueCallKind } from "@xos/data/cue-calls";
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
 * decide every write. A feed has a name, content and, on a project feed, an audience and a show
 * department, set when it is added or with Edit (B7, ADR 0146); the 2961 RPCs refuse a bad one.
 */

export interface CalendarFeedFormState {
  readonly ok?: boolean;
  readonly error?: string;
  /** The subscription link, shown once after adding a feed or getting a new link. */
  readonly link?: string;
}

const KNOWN_RULES = new Set<string>([...CALENDAR_FEED_RULES, "calendar_feed_revoked"]);

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
const source = z.enum(CALENDAR_FEED_SOURCES);
const cueCallKind = z.enum(CUE_CALL_KINDS as unknown as [CueCallKind, ...CueCallKind[]]);
const department = z.string().regex(/^[0-9]000$/);

/**
 * A feed's configuration from the form (B7). The four 4.0 sources alone are saved as the default
 * (null), so the feed keeps serving exactly what a new feed serves; none checked is sent as an empty
 * list, which the RPC refuses with calendar_feed_sources, as it refuses more than 50 people. An
 * audience applies to a project feed only.
 */
async function configurationFrom(
  form: FormData,
  projectFeed: boolean,
): Promise<FeedConfiguration | null> {
  const raw = form.getAll("sources").map((v) => source.safeParse(v));
  if (raw.some((r) => !r.success)) return null;
  const picked = new Set(raw.flatMap((r) => (r.success ? [r.data] : [])));
  const sources: CalendarFeedSource[] = CALENDAR_FEED_SOURCES.filter((s) => picked.has(s));
  const isDefault =
    sources.length === DEFAULT_FEED_SOURCES.length &&
    DEFAULT_FEED_SOURCES.every((s) => picked.has(s));
  const name = form.get("name");
  const kind = projectFeed ? form.get("audienceKind") : null;
  let audience: FeedConfiguration["audience"] = null;
  if (kind === "people") {
    const people = form.getAll("personIds").map((v) => id.safeParse(v));
    if (people.some((p) => !p.success)) return null;
    const personIds = people.flatMap((p) => (p.success ? [p.data] : []));
    audience = personIds.length > 0 ? { kind: "people", personIds } : null;
  } else if (kind === "team") {
    const team = id.safeParse(form.get("teamId"));
    if (!team.success) return null;
    audience = { kind: "team", teamId: team.data };
  } else if (kind === "department") {
    const code = department.safeParse(form.get("departmentCode"));
    if (!code.success) return null;
    audience = { kind: "department", departmentCode: code.data };
  } else if (kind !== null && kind !== "everyone") {
    return null;
  }
  const call = projectFeed ? form.get("cueCallKind") : null;
  const parsedCall =
    call === null || call === "" || call === "any" ? null : cueCallKind.safeParse(call);
  if (parsedCall !== null && !parsedCall.success) return null;
  return {
    name: typeof name === "string" ? name : null,
    sources: isDefault ? null : sources,
    audience,
    cueCallKind: parsedCall?.success ? parsedCall.data : null,
  };
}

export async function addCalendarFeedAction(
  _: CalendarFeedFormState,
  form: FormData,
): Promise<CalendarFeedFormState> {
  const ctx = await contextFor(form);
  const parsed = scope.safeParse(form.get("scope"));
  if (!parsed.success) return { error: "invalid" };
  const projectId = parsed.data === "mine" ? null : parsed.data;
  const config = await configurationFrom(form, projectId !== null);
  if (config === null) return { error: "invalid" };
  return finish(
    ctx.org.slug,
    await createCalendarFeed(ctx.viewer.db, ctx.org.id, projectId, config),
  );
}

/** Edit: replaces a feed's name, content, audience and show department; its link stays. */
export async function configureCalendarFeedAction(
  _: CalendarFeedFormState,
  form: FormData,
): Promise<CalendarFeedFormState> {
  const ctx = await contextFor(form);
  const parsed = id.safeParse(form.get("id"));
  if (!parsed.success) return { error: "denied" };
  const config = await configurationFrom(form, form.get("projectFeed") === "true");
  if (config === null) return { error: "invalid" };
  return finish(ctx.org.slug, await configureCalendarFeed(ctx.viewer.db, parsed.data, config));
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
