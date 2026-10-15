import { DaySheetsPage } from "@/components/show/show-pages";
import { requireModuleNode } from "@/components/work/load";

/** Show > Day sheets (Section 4.5.5): the plan of each project day, published once. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/show/day-sheets">) {
  const ctx = await requireModuleNode("show.day-sheets", await params);
  return <DaySheetsPage ctx={ctx} node="show.day-sheets" search={await searchParams} />;
}
