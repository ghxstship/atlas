import { ScanLogSection } from "@/components/credentials/sections";
import { loadModulePage } from "@/lib/operations/context";

/** The scan log (Section 4.2): every scan with the decision the database made, and a scan desk. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/credentials/scan-log">) {
  const page = await loadModulePage("credentials.scan-log", await params, await searchParams);
  return <ScanLogSection page={page} />;
}
