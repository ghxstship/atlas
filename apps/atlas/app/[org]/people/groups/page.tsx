import { requireNode } from "@/lib/shell/require-node";
import { GroupsSection } from "@/components/workforce/groups";
import { nodeHref } from "@/lib/shell/sitemap";

/** People > Groups (Section 4.9 Groups). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/people/groups">) {
  const routeParams = await params;
  const ctx = await requireNode("people.groups", routeParams);
  return (
    <GroupsSection
      ctx={ctx}
      path={nodeHref("people.groups", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
