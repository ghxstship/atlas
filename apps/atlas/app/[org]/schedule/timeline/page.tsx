import { requireModuleNode } from "@/components/work/load";
import { RecordsPage } from "@/components/work/records-page";

/** Schedule > Timeline (Section 4.5.5): dated records on a Gantt with dependencies and the latest baseline. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/schedule/timeline">) {
  const ctx = await requireModuleNode("schedule.timeline", await params);
  return (
    <RecordsPage
      ctx={ctx}
      node="schedule.timeline"
      search={await searchParams}
      emptyKey="timeline"
      datedOnly
    />
  );
}
