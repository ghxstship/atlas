import { requireNode } from "@/components/shell/sitemap-page";
import { FeedSection } from "@/components/workforce/feed";
import { nodeHref } from "@/lib/shell/sitemap";

/** Knowledge > Feed (Section 4.9 Feed, Polls and surveys). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/knowledge/feed">) {
  const routeParams = await params;
  const ctx = await requireNode("knowledge.feed", routeParams);
  return (
    <FeedSection
      ctx={ctx}
      path={nodeHref("knowledge.feed", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
