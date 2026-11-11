import { moduleScope } from "@/components/logistics-hospitality/kit";
import { SpaceBookingsSection } from "@/components/logistics-hospitality/space-bookings";
import { nodeHref } from "@/lib/shell/sitemap";

/** Hospitality > Green rooms and dressing rooms (B5, G-32): space bookings at the projects' venues. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/hospitality/rooms">) {
  const routeParams = await params;
  const scope = await moduleScope("hospitality.rooms", routeParams);
  return (
    <SpaceBookingsSection
      scope={scope}
      search={await searchParams}
      base={nodeHref("hospitality.rooms", routeParams) ?? "/"}
    />
  );
}
