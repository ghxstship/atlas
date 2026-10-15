import { IssuedSection } from "@/components/credentials/sections";
import { loadModulePage } from "@/lib/operations/context";

/** Issued credentials (Section 4.2, invariant 21): issue, change the window, revoke, and see the badge and recent scans. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/credentials/issued">) {
  const page = await loadModulePage("credentials.issued", await params, await searchParams);
  return <IssuedSection page={page} />;
}
