import { requireModuleNode } from "@/components/work/load";
import { RecurringPage } from "@/components/work/work-pages";

/** Work > Recurring (Section 4.5.5): records that repeat on a rule. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/work/recurring">) {
  const ctx = await requireModuleNode("work.recurring", await params);
  return <RecurringPage ctx={ctx} node="work.recurring" search={await searchParams} />;
}
