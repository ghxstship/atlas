import { requireNode } from "@/lib/shell/require-node";
import { HelpDeskSection } from "@/components/workforce/help-desk";
import { nodeHref } from "@/lib/shell/sitemap";

/** People > Help Desk (Section 4.9 Help desk). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/people/help-desk">) {
  const routeParams = await params;
  const ctx = await requireNode("people.help-desk", routeParams);
  return (
    <HelpDeskSection
      ctx={ctx}
      path={nodeHref("people.help-desk", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
