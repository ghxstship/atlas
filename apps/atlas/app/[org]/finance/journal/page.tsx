import { JournalView } from "@/components/finance/ledger-views";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Journal (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/journal">) {
  const page = await loadFinancePage("finance.journal", await params, await searchParams);
  return <JournalView page={page} />;
}
