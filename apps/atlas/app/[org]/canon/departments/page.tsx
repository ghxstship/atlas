import { requireNode } from "@/lib/shell/require-node";
import { CanonDepartments } from "@/components/canon/browser";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Departments (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/canon/departments">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.departments", routeParams);
  return (
    <CanonDepartments
      ctx={ctx}
      path={nodeHref("canon.departments", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
