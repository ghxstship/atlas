import { moduleScope } from "@/components/logistics-hospitality/kit";
import { TransfersSection } from "@/components/logistics-hospitality/transfers";
import { nodeHref } from "@/lib/shell/sitemap";

/** Hospitality > Transfers (B5, G-33): ground transfers with their vehicles, drivers and passengers. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/hospitality/transfers">) {
  const routeParams = await params;
  const scope = await moduleScope("hospitality.transfers", routeParams);
  return (
    <TransfersSection
      scope={scope}
      search={await searchParams}
      base={nodeHref("hospitality.transfers", routeParams) ?? "/"}
    />
  );
}
