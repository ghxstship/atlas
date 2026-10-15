import { requireModuleNode } from "@/components/work/load";
import { RecordsPage } from "@/components/work/records-page";

/** Schedule > Calendar (Section 4.5.5): dated records on a month calendar. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/schedule/calendar">) {
  const ctx = await requireModuleNode("schedule.calendar", await params);
  return (
    <RecordsPage
      ctx={ctx}
      node="schedule.calendar"
      search={await searchParams}
      emptyKey="calendar"
      datedOnly
    />
  );
}
