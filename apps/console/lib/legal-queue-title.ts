import type { LegalQueueItem } from "@xos/data/console-legal-queue";

interface Words {
  readonly t: (key: string, values?: Record<string, string | number>) => string;
  readonly label: (group: string, value: string) => string;
}

/**
 * What an item is called on screen. An item added by hand keeps what the operator typed. A fed or system item holds only a
 * code, so an operator reads it in their own language, and a listing's title is read live from its source.
 */
export function legalQueueTitle(item: LegalQueueItem, { t, label }: Words): string {
  if (item.liveTitle) return item.liveTitle;
  switch (item.ruleCode) {
    case "listing_report":
    case "moderation_appeal":
      return t("legalQueue.fedTitles.listing");
    case "repeat_infringer_review":
      return t("legalQueue.fedTitles.repeat", { count: item.counted ?? 0 });
    case "dsar_customer_register":
      return label("legalQueue.requestTypes", item.title);
    case "undelivered_notice":
      return t("legalQueue.fedTitles.undelivered");
    case "queue_feed_failure":
      return t("legalQueue.fedTitles.feed", { feed: label("legalQueue.feeds", item.title) });
    default:
      return item.title;
  }
}
