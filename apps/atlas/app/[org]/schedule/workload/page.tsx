import { WorkloadPage } from "@/components/schedule/workload-page";
import { requireModuleNode } from "@/components/work/load";

/** Schedule > Workload (B4, G-45): hours per person per day from shifts and task estimates, never stored. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/schedule/workload">) {
  const ctx = await requireModuleNode("schedule.workload", await params);
  return <WorkloadPage ctx={ctx} search={await searchParams} />;
}
