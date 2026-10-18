import { requireNode } from "@/lib/shell/require-node";
import { CanonRoles } from "@/components/canon/browser";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Roles (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/canon/roles">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.roles", routeParams);
  return (
    <CanonRoles
      ctx={ctx}
      path={nodeHref("canon.roles", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
