import { EmptyStateLink } from "@/components/ui";
import type { Copy } from "@/lib/collection-kit/i18n";
import { EmptyRefresh } from "./kit";

/** The empty state of an A16 page: the create flow for writers, a refresh for readers. */
export function emptyFor(t: Copy, canWrite: boolean, createHref: string, page: string) {
  return canWrite ? (
    <EmptyStateLink
      icon="Inbox"
      sentence={t(`${page}.empty`)}
      actionLabel={t(`${page}.create`)}
      href={createHref}
    />
  ) : (
    <EmptyRefresh icon="Inbox" sentence={t(`${page}.emptyRead`)} />
  );
}
