import { QuotesView } from "@/components/finance/quotes-view";
import { LiveList } from "@/components/live/live-list";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Quotes (G-188 phase 1, ADR 0152): client quotes built from budgets, updating live. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/quotes">) {
  const routeParams = await params;
  const page = await loadFinancePage("finance.quotes", routeParams, await searchParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["quotes", "quote_versions"]} />
      <QuotesView page={page} />
    </>
  );
}
