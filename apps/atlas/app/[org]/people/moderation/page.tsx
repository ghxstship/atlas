import { requireNode } from "@/lib/shell/require-node";
import { ModerationSection } from "@/components/workforce/moderation";
import { nodeHref } from "@/lib/shell/sitemap";

/** People > Reported Content (ADR 0033 decision 57): reported posts, comments and messages for the org's moderators. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/people/moderation">) {
  const routeParams = await params;
  const ctx = await requireNode("people.moderation", routeParams);
  return (
    <ModerationSection
      ctx={ctx}
      path={nodeHref("people.moderation", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
