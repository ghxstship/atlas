import { moduleScope } from "@/components/logistics-hospitality/kit";
import { TravelGridSection } from "@/components/logistics-hospitality/travel-grid";
import { nodeHref } from "@/lib/shell/sitemap";

/** Hospitality > Travel (B5, G-58): the flight grid of every project the viewer reads hospitality on. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/hospitality/travel">) {
  const routeParams = await params;
  const scope = await moduleScope("hospitality.travel", routeParams);
  return (
    <TravelGridSection
      scope={scope}
      search={await searchParams}
      base={nodeHref("hospitality.travel", routeParams) ?? "/"}
    />
  );
}
