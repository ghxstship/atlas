import { PeriodsView } from "@/components/finance/ledger-views";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Periods (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/periods">) {
  const page = await loadFinancePage("finance.periods", await params, await searchParams);
  return <PeriodsView page={page} />;
}
