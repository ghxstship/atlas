import { AccessGridSection } from "@/components/credentials/sections";
import { loadModulePage } from "@/lib/operations/context";

/** The access grid (Section 4.2): which category enters which zone, at what canon access level, when. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/credentials/access-grid">) {
  const page = await loadModulePage("credentials.access-grid", await params, await searchParams);
  return <AccessGridSection page={page} />;
}
