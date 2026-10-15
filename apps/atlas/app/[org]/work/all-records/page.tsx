import { requireModuleNode } from "@/components/work/load";
import { RecordsPage } from "@/components/work/records-page";

/** Work > All records (Section 4.5.5): every record kind as a list, table, board, calendar or timeline. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/work/all-records">) {
  const ctx = await requireModuleNode("work.all-records", await params);
  return (
    <RecordsPage
      ctx={ctx}
      node="work.all-records"
      search={await searchParams}
      emptyKey="allRecords"
    />
  );
}
