import { PaymentsView } from "@/components/finance/payments-view";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Payments and settlements (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/payments">) {
  const page = await loadFinancePage("finance.payments", await params, await searchParams);
  return <PaymentsView page={page} />;
}
