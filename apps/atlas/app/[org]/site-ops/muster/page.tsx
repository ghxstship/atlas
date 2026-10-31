import { requireNode } from "@/lib/shell/require-node";
import { MusterSection } from "@/components/workforce/muster";
import { nodeHref } from "@/lib/shell/sitemap";

/** Site Operations > Muster List (Section 4.9, B8 G-149: everyone placed in a zone now, by zone). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/site-ops/muster">) {
  const routeParams = await params;
  const ctx = await requireNode("site-ops.muster", routeParams);
  return (
    <MusterSection
      ctx={ctx}
      path={nodeHref("site-ops.muster", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
