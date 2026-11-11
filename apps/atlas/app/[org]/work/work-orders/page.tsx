import { requireModuleNode } from "@/components/work/load";
import { WorkOrdersPage } from "@/components/work/work-pages";
import { LiveList } from "@/components/live/live-list";

/** Work > Work orders (Section 4.5.5): scoped work put out for bids, awarded and carried out. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/work/work-orders">) {
  const routeParams = await params;
  const ctx = await requireModuleNode("work.work-orders", routeParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["work_orders"]} />
      <WorkOrdersPage ctx={ctx} node="work.work-orders" search={await searchParams} />
    </>
  );
}
