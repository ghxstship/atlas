import { IncidentsSection } from "@/components/incidents/sections";
import { loadModulePage } from "@/lib/operations/context";

/** The incident CAD log (Section 4.2, invariant 22): report, dispatch, contain and close with sign-off, with parties, media, responders and masked medical encounters. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/safety/incidents">) {
  const page = await loadModulePage("safety.incidents", await params, await searchParams);
  return <IncidentsSection page={page} />;
}
