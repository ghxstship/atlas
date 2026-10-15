import { requireModuleNode } from "@/components/work/load";
import { WorkOrdersPage } from "@/components/work/work-pages";

/** Work > Work orders (Section 4.5.5): scoped work put out for bids, awarded and carried out. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/work/work-orders">) {
  const ctx = await requireModuleNode("work.work-orders", await params);
  return <WorkOrdersPage ctx={ctx} node="work.work-orders" search={await searchParams} />;
}
