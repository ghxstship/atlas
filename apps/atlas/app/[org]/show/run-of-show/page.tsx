import { RunsPage } from "@/components/show/show-pages";
import { requireModuleNode } from "@/components/work/load";

/** Show > Run of show (Section 4.5.5): running orders, cues and live cue calls (journey 15). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/show/run-of-show">) {
  const ctx = await requireModuleNode("show.run-of-show", await params);
  return <RunsPage ctx={ctx} node="show.run-of-show" search={await searchParams} />;
}
