import { requireNode } from "@/components/shell/sitemap-page";
import { InsuranceCertificates } from "@/components/vendors/certificates";
import { nodeHref } from "@/lib/shell/sitemap";

/** Vendors > Insurance certificates (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/vendors/insurance-certificates">) {
  const routeParams = await params;
  const ctx = await requireNode("vendors.insurance-certificates", routeParams);
  return (
    <InsuranceCertificates
      ctx={ctx}
      path={nodeHref("vendors.insurance-certificates", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
