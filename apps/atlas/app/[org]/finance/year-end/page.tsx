import { YearEndView } from "@/components/finance/year-end-view";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Year-end: the 1099-NEC payees of a tax year and their FIRE file (A43, A38-006). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/year-end">) {
  const page = await loadFinancePage("finance.year-end", await params, await searchParams);
  return <YearEndView page={page} />;
}
