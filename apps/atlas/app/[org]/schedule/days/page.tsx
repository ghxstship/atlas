import { DaysPage } from "@/components/schedule/days-page";
import { requireModuleNode } from "@/components/work/load";

/** Schedule > Days (B4, G-38): the projects' day types, with the day editor, the day grid and day templates. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/schedule/days">) {
  const ctx = await requireModuleNode("schedule.days", await params);
  return <DaysPage ctx={ctx} search={await searchParams} />;
}
