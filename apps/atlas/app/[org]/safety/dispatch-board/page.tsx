import { DispatchBoardSection } from "@/components/incidents/sections";
import { loadModulePage } from "@/lib/operations/context";

/** The dispatch board (Section 11.11): open incidents by severity with live refresh, dispatch in one step from the peek. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/safety/dispatch-board">) {
  const page = await loadModulePage("safety.dispatch-board", await params, await searchParams);
  return <DispatchBoardSection page={page} />;
}
