import { CallSheetsPage } from "@/components/show/show-pages";
import { requireModuleNode } from "@/components/work/load";

/** Show > Call sheets (Section 4.5.5): each day's calls from its crew shifts, published to crew. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/show/call-sheets">) {
  const ctx = await requireModuleNode("show.call-sheets", await params);
  return <CallSheetsPage ctx={ctx} node="show.call-sheets" search={await searchParams} />;
}
