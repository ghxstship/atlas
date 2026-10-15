import { requireModuleNode } from "@/components/work/load";
import { RecordsPage } from "@/components/work/records-page";

/** Schedule > Milestones (Section 4.5.5): Milestone records as a list, table or timeline. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/schedule/milestones">) {
  const ctx = await requireModuleNode("schedule.milestones", await params);
  return (
    <RecordsPage
      ctx={ctx}
      node="schedule.milestones"
      search={await searchParams}
      emptyKey="milestones"
      fixedKinds={["Milestone"]}
    />
  );
}
