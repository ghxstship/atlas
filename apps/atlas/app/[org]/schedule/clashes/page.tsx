import { ClashesPage } from "@/components/schedule/clashes-page";
import { requireModuleNode } from "@/components/work/load";

/** Schedule > Clashes (B4, G-46, G-47): crew, supplier and running-order clashes, computed at read time. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/schedule/clashes">) {
  const ctx = await requireModuleNode("schedule.clashes", await params);
  return <ClashesPage ctx={ctx} search={await searchParams} />;
}
