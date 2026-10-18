import { requireNode } from "@/lib/shell/require-node";
import { InvoiceMatchingSection } from "@/components/procurement/matching";
import { nodeHref } from "@/lib/shell/sitemap";

/** Procurement > Invoice matching (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/procurement/invoice-matching">) {
  const routeParams = await params;
  const ctx = await requireNode("procurement.invoice-matching", routeParams);
  return (
    <InvoiceMatchingSection
      ctx={ctx}
      path={nodeHref("procurement.invoice-matching", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
