import { requireNode } from "@/lib/shell/require-node";
import { CanonMetrics } from "@/components/canon/browser";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Metrics (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/canon/metrics">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.metrics", routeParams);
  return (
    <CanonMetrics
      ctx={ctx}
      path={nodeHref("canon.metrics", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
