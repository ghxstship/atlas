import { requireNode } from "@/lib/shell/require-node";
import { GuestCheckInSection } from "@/components/workforce/guest-check-in";
import { nodeHref } from "@/lib/shell/sitemap";

/** Site Operations > Guest Check-In (Section 4.9 guest list check-in at doors). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/site-ops/guest-check-in">) {
  const routeParams = await params;
  const ctx = await requireNode("site-ops.guest-check-in", routeParams);
  return (
    <GuestCheckInSection
      ctx={ctx}
      path={nodeHref("site-ops.guest-check-in", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
