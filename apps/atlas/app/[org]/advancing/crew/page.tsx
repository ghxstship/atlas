import { getNode } from "@xos/ia";
import { advancingPage } from "@/components/advancing/context";
import { CrewRoster } from "@/components/advancing/crew-roster";
import { flatSearch } from "@/components/advancing/shared";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/** Advancing > Crew Roster (R4, ADR 0100): every party's people on the org's engagements, to review. */
export default async function CrewRosterPage({
  params,
  searchParams,
}: PageProps<"/[org]/advancing/crew">) {
  const routeParams = await params;
  const search = flatSearch(await searchParams);
  const actx = await advancingPage("advancing.crew", routeParams, search["project"]);
  const t = await getTranslate();
  return (
    <CrewRoster
      actx={actx}
      path={`/${routeParams.org}/advancing/crew`}
      search={search}
      title={t(getNode(sitemap, "advancing.crew").node.label)}
    />
  );
}
