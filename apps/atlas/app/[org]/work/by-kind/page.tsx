import { requireModuleNode } from "@/components/work/load";
import { RecordsPage } from "@/components/work/records-page";

/** Work > By kind (Section 4.5.5): records on a board with one column per record kind. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/work/by-kind">) {
  const ctx = await requireModuleNode("work.by-kind", await params);
  return (
    <RecordsPage
      ctx={ctx}
      node="work.by-kind"
      search={await searchParams}
      emptyKey="byKind"
      boardBy="kind"
    />
  );
}
