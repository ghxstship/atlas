import { AccountsView } from "@/components/finance/reference-views";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Chart of accounts, read-only (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/finance/chart-of-accounts">) {
  const page = await loadFinancePage("finance.chart-of-accounts", await params, await searchParams);
  return <AccountsView page={page} />;
}
