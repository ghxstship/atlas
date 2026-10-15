import { BeosSection } from "@/components/logistics-hospitality/beos";
import { moduleScope } from "@/components/logistics-hospitality/kit";
import { nodeHref } from "@/lib/shell/sitemap";

/** Hospitality > BEOs (Section 4.5.5): every project's banquet event orders. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/hospitality/beos">) {
  const routeParams = await params;
  const scope = await moduleScope("hospitality.beos", routeParams);
  return (
    <BeosSection
      scope={scope}
      search={await searchParams}
      base={nodeHref("hospitality.beos", routeParams) ?? "/"}
    />
  );
}
