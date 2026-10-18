import { requireNode } from "@/lib/shell/require-node";
import { CanonDisciplines } from "@/components/canon/browser";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Disciplines (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/canon/disciplines">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.disciplines", routeParams);
  return (
    <CanonDisciplines
      ctx={ctx}
      path={nodeHref("canon.disciplines", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
