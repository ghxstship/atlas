import { moduleScope } from "@/components/logistics-hospitality/kit";
import { YardSection } from "@/components/logistics-hospitality/yard";
import { nodeHref } from "@/lib/shell/sitemap";
import { LiveList } from "@/components/live/live-list";

/** Logistics > Marshalling yard log (Section 4.5.5): the gate queue and the yard log. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/logistics/marshalling-yard-log">) {
  const routeParams = await params;
  const scope = await moduleScope("logistics.marshalling-yard-log", routeParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["gate_queue", "marshalling_log"]} />
      <YardSection
        scope={scope}
        search={await searchParams}
        base={nodeHref("logistics.marshalling-yard-log", routeParams) ?? "/"}
      />
    </>
  );
}
