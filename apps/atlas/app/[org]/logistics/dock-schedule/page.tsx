import { DockSection } from "@/components/logistics-hospitality/dock";
import { moduleScope } from "@/components/logistics-hospitality/kit";
import { nodeHref } from "@/lib/shell/sitemap";

/** Logistics > Dock schedule (Section 4.5.5): every project's dock slots by dock and day. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/logistics/dock-schedule">) {
  const routeParams = await params;
  const scope = await moduleScope("logistics.dock-schedule", routeParams);
  return (
    <DockSection
      scope={scope}
      search={await searchParams}
      base={nodeHref("logistics.dock-schedule", routeParams) ?? "/"}
    />
  );
}
