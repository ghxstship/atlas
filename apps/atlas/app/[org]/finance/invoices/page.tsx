import { InvoicesView } from "@/components/finance/invoices-view";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Invoices (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/invoices">) {
  const page = await loadFinancePage("finance.invoices", await params, await searchParams);
  return <InvoicesView page={page} />;
}
