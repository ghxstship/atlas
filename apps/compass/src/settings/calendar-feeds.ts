/**
 * Settings, Calendar Feeds in Compass (Section 4.5.6 personal item 12, Section 4.6.5, A84, ADR 0040, ADR 0072): the
 * person's own feeds across every org they work with, the same app.person_calendar_feeds Gateway's section manages,
 * through the same @xos/data functions and the 1410 RPCs.
 *
 * A feed's token is shown once, when the feed is added or gets a new link; only its hash is stored, so the link
 * lives in the screen's memory until the person leaves it and never reaches the device database. The link is on
 * Gateway's origin, as Gateway issues it, and the screen offers it to copy and share through the system share sheet
 * and to open in the phone's calendar app (webcal). Adding, a new link and revoking all need the server's answer, so
 * they are disabled offline; the list shows from the device. A feed has a name and content, cues included, set
 * when it is added or with Edit (B7, ADR 0146); the device keeps both with the list, never the token.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CALENDAR_FEED_SOURCES,
  calendarFeedUrl,
  DEFAULT_FEED_SOURCES,
  listMyPersonCalendarFeeds,
  webcalUrl,
  type CalendarFeedSource,
  type PersonFeedConfiguration,
} from "@xos/data/calendar-feeds";
import type { XosClient } from "@xos/data/client";
import type { DataError } from "@xos/data/result";
import type { Row } from "@xos/sync";

/** The device-local copy of the person's live feeds. */
export const CALENDAR_FEEDS_MIRROR = "_me_calendar_feeds";

/** A feed as the device keeps it: its name, content, the last four characters of its link and its dates, never the token. */
export interface FeedRow extends Row {
  readonly tokenHint: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly lastAccessedAt: string | null;
  /** Null shows the default name. */
  readonly name?: string | null;
  /** Null shows the default set. */
  readonly sources?: readonly CalendarFeedSource[] | null;
}

/** Every source a feed may show, in order: shifts, meetings, milestones, deadlines and cues. */
export const FEED_SOURCES = CALENDAR_FEED_SOURCES;

/** The sources a feed shows: its saved set, or the default four. */
export function shownSources(feed: Pick<FeedRow, "sources">): readonly CalendarFeedSource[] {
  return feed.sources ?? DEFAULT_FEED_SOURCES;
}

/** The configuration a form sends: the default four alone are saved as the default (null). */
export function feedConfiguration(
  name: string,
  picked: ReadonlySet<CalendarFeedSource>,
): PersonFeedConfiguration {
  const sources = CALENDAR_FEED_SOURCES.filter((s) => picked.has(s));
  const isDefault =
    sources.length === DEFAULT_FEED_SOURCES.length &&
    DEFAULT_FEED_SOURCES.every((s) => picked.has(s));
  return { name: name.trim() === "" ? null : name, sources: isDefault ? null : sources };
}

/** The person's live feeds, newest first, or null when the read failed. */
export async function readMyFeeds(client: SupabaseClient): Promise<FeedRow[] | null> {
  const result = await listMyPersonCalendarFeeds(client as unknown as XosClient);
  if (!result.ok) return null;
  return result.data.map((f) => ({
    id: f.id,
    tokenHint: f.tokenHint,
    createdAt: f.createdAt,
    rotatedAt: f.rotatedAt,
    lastAccessedAt: f.lastAccessedAt,
    name: f.name,
    sources: f.sources,
  }));
}

/** The feeds newest first, as Gateway lists them. */
export function feedItems(feeds: readonly FeedRow[]): FeedRow[] {
  return [...feeds].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A link just issued: the https subscription link on Gateway's origin and its webcal form for the calendar app. */
export interface IssuedLink {
  /** The feed it belongs to. */
  readonly feedId: string;
  readonly url: string;
  readonly webcal: string;
}

export function issuedLink(gatewayUrl: string, feedId: string, token: string): IssuedLink {
  const url = calendarFeedUrl(gatewayUrl, token);
  return { feedId, url, webcal: webcalUrl(url) };
}

const KNOWN_RULES = new Set(["calendar_feed_limit", "calendar_feed_name", "calendar_feed_sources"]);

/** Gateway's refusal keys for a feed change (gateway.settings.calendarFeeds.errors.*), as its actions name them. */
export function feedErrorKey(error: DataError): string {
  const C = "gateway.settings.calendarFeeds.errors";
  if (error.kind === "refusal" && KNOWN_RULES.has(error.rule)) return `${C}.${error.rule}`;
  if (error.kind === "not-found") return `${C}.denied`;
  return `${C}.unexpected`;
}
