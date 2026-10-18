import { requireNode } from "@/lib/shell/require-node";
import { WeatherSection } from "@/components/workforce/weather";
import { nodeHref } from "@/lib/shell/sitemap";

/** Site Operations > Weather (Section 4.9 weather monitoring). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/site-ops/weather">) {
  const routeParams = await params;
  const ctx = await requireNode("site-ops.weather", routeParams);
  return (
    <WeatherSection
      ctx={ctx}
      path={nodeHref("site-ops.weather", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
