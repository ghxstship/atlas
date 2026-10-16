import { requireNode } from "@/components/shell/sitemap-page";
import { ReceiptsSection } from "@/components/procurement/receipts";
import { nodeHref } from "@/lib/shell/sitemap";

/** Procurement > Receipts (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/procurement/receipts">) {
  const routeParams = await params;
  const ctx = await requireNode("procurement.receipts", routeParams);
  return (
    <ReceiptsSection
      ctx={ctx}
      path={nodeHref("procurement.receipts", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
