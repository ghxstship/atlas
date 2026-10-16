import { requireNode } from "@/components/shell/sitemap-page";
import { EventsSection } from "@/components/workforce/events";
import { nodeHref } from "@/lib/shell/sitemap";

/** Schedule > Events (Section 4.9 Events). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/schedule/events">) {
  const routeParams = await params;
  const ctx = await requireNode("schedule.events", routeParams);
  return (
    <EventsSection
      ctx={ctx}
      path={nodeHref("schedule.events", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
