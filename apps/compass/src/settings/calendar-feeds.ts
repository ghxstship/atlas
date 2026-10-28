/**
 * Settings, Calendar Feeds in Compass (Section 4.5.6 personal item 12, Section 4.6.5, A84, ADR 0040, ADR 0072): the
 * person's own feeds across every org they work with, the same app.person_calendar_feeds Gateway's section manages,
 * through the same @xos/data functions and the 1410 RPCs.
 *
 * A feed's token is shown once, when the feed is added or gets a new link; only its hash is stored, so the link
 * lives in the screen's memory until the person leaves it and never reaches the device database. The link is on
 * Gateway's origin, as Gateway issues it, and the screen offers it to copy and share through the system share sheet
 * and to open in the phone's calendar app (webcal). Adding, a new link and revoking all need the server's answer, so
 * they are disabled offline; the list shows from the device.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarFeedUrl, listMyPersonCalendarFeeds, webcalUrl } from "@xos/data/calendar-feeds";
import type { XosClient } from "@xos/data/client";
import type { DataError } from "@xos/data/result";
import type { Row } from "@xos/sync";

/** The device-local copy of the person's live feeds. */
export const CALENDAR_FEEDS_MIRROR = "_me_calendar_feeds";

/** A feed as the device keeps it: the last four characters of its link and its dates, never the token. */
export interface FeedRow extends Row {
  readonly tokenHint: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly lastAccessedAt: string | null;
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

/** Gateway's refusal keys for a feed change (gateway.settings.calendarFeeds.errors.*), as its actions name them. */
export function feedErrorKey(error: DataError): string {
  const C = "gateway.settings.calendarFeeds.errors";
  if (error.kind === "refusal" && error.rule === "calendar_feed_limit") return `${C}.${error.rule}`;
  if (error.kind === "not-found") return `${C}.denied`;
  return `${C}.unexpected`;
}
