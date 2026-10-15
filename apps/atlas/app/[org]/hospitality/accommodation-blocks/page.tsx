import { BlocksSection } from "@/components/logistics-hospitality/blocks";
import { moduleScope } from "@/components/logistics-hospitality/kit";
import { nodeHref } from "@/lib/shell/sitemap";

/** Hospitality > Accommodation blocks (Section 4.5.5): room blocks and room assignments. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/hospitality/accommodation-blocks">) {
  const routeParams = await params;
  const scope = await moduleScope("hospitality.accommodation-blocks", routeParams);
  return (
    <BlocksSection
      scope={scope}
      search={await searchParams}
      base={nodeHref("hospitality.accommodation-blocks", routeParams) ?? "/"}
    />
  );
}
