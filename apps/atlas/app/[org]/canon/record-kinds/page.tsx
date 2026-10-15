import { requireNode } from "@/components/shell/sitemap-page";
import { CanonRecordKinds } from "@/components/canon/browser";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Record kinds (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/canon/record-kinds">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.record-kinds", routeParams);
  return (
    <CanonRecordKinds
      ctx={ctx}
      path={nodeHref("canon.record-kinds", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
