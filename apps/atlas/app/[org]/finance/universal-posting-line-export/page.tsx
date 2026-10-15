import { UplView } from "@/components/finance/reference-views";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Universal Posting Line export (Section 3.11). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/finance/universal-posting-line-export">) {
  const page = await loadFinancePage(
    "finance.universal-posting-line-export",
    await params,
    await searchParams,
  );
  return <UplView page={page} />;
}
