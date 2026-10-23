import type { ActivityEntry } from "@xos/data/activity";

/** The most items one summary reads: aurora.summarize takes at most 100. */
export const MAX_SUMMARY_ITEMS = 100;

/**
 * A week of a feed, newest first: pages back until an entry older than `since` (the week's first
 * instant on the project's calendar) or the end of the feed, keeping at most MAX_SUMMARY_ITEMS and
 * saying when it stopped short (A95).
 */
export async function weekOfActivity(
  page: (
    before: string | null,
  ) => Promise<{ entries: readonly ActivityEntry[]; next: string | null }>,
  since: string,
): Promise<{ entries: ActivityEntry[]; truncated: boolean }> {
  const entries: ActivityEntry[] = [];
  let before: string | null = null;
  for (;;) {
    const result = await page(before);
    for (const entry of result.entries) {
      if (Date.parse(entry.at) < Date.parse(since)) return { entries, truncated: false };
      if (entries.length === MAX_SUMMARY_ITEMS) return { entries, truncated: true };
      entries.push(entry);
    }
    if (result.next === null) return { entries, truncated: false };
    before = result.next;
  }
}
