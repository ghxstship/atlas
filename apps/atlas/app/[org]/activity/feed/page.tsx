import { ActivityPage } from "@/components/activity/activity-page";
import { requireNode } from "@/lib/shell/require-node";

/** Activity > Org activity feed (Section 4.5.5): changes across the org the viewer may read. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/activity/feed">) {
  const routeParams = await params;
  const ctx = await requireNode("activity.feed", routeParams);
  return (
    <ActivityPage
      ctx={ctx}
      node="activity.feed"
      params={routeParams}
      searchParams={await searchParams}
    />
  );
}
