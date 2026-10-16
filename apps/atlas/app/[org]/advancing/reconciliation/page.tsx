import { getNode } from "@xos/ia";
import { advancingPage } from "@/components/advancing/context";
import { ReconciliationCollection } from "@/components/advancing/reconciliation";
import { flatSearch } from "@/components/advancing/shared";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/** Advancing > Reconciliation (Section 4.5.5): requirement runs against stated capabilities. */
export default async function ReconciliationPage({
  params,
  searchParams,
}: PageProps<"/[org]/advancing/reconciliation">) {
  const routeParams = await params;
  const search = flatSearch(await searchParams);
  const actx = await advancingPage("advancing.reconciliation", routeParams, search["project"]);
  const t = await getTranslate();
  return (
    <ReconciliationCollection
      actx={actx}
      path={`/${routeParams.org}/advancing/reconciliation`}
      search={search}
      title={t(getNode(sitemap, "advancing.reconciliation").node.label)}
      ridersHref={`/${routeParams.org}/advancing/riders`}
    />
  );
}
