import { BaselinesPage } from "@/components/schedule/schedule-pages";
import { requireModuleNode } from "@/components/work/load";

/** Schedule > Baselines (Section 4.5.5): captured, locked baselines and their variance. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/schedule/baselines">) {
  const ctx = await requireModuleNode("schedule.baselines", await params);
  return <BaselinesPage ctx={ctx} node="schedule.baselines" search={await searchParams} />;
}
