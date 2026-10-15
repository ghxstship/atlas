import { EngagementsView } from "@/components/opportunities/engagements-view";
import { setupPage, type SearchParams } from "@/lib/opportunities/page";
import { nodeHref } from "@/lib/shell/sitemap";

/** Engagements (Section 4.5.5 Opportunities): every external engagement of the org, stages 6 to 9. */
export default async function EngagementsPage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/engagements">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.engagements",
    routeParams,
    (await searchParams) as SearchParams,
  );
  return (
    <EngagementsView
      page={page}
      emptyHref={nodeHref("opportunities.pipeline", routeParams) ?? page.base}
    />
  );
}
