import { requireNode } from "@/components/shell/sitemap-page";
import { CanonPhases } from "@/components/canon/browser";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Phases and gates (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/canon/phases-and-gates">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.phases-and-gates", routeParams);
  return (
    <CanonPhases
      ctx={ctx}
      path={nodeHref("canon.phases-and-gates", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
