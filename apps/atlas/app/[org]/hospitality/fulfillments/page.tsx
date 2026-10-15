import { FulfillmentsSection } from "@/components/logistics-hospitality/fulfillments";
import { moduleScope } from "@/components/logistics-hospitality/kit";
import { nodeHref } from "@/lib/shell/sitemap";

/** Hospitality > Fulfillments (Section 4.5.5): every project's fulfillments, with the project filter. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/hospitality/fulfillments">) {
  const routeParams = await params;
  const scope = await moduleScope("hospitality.fulfillments", routeParams);
  return (
    <FulfillmentsSection
      scope={scope}
      search={await searchParams}
      base={nodeHref("hospitality.fulfillments", routeParams) ?? "/"}
    />
  );
}
