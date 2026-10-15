import { requireModuleNode } from "@/components/work/load";
import { PunchListsPage } from "@/components/work/work-pages";

/** Work > Punch lists (Section 4.5.5): corrections before handover, each a Task record. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/work/punch-lists">) {
  const ctx = await requireModuleNode("work.punch-lists", await params);
  return <PunchListsPage ctx={ctx} node="work.punch-lists" search={await searchParams} />;
}
