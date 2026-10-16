import { EmergencyCodesSection } from "@/components/incidents/sections";
import { loadModulePage } from "@/lib/operations/context";

/** The global emergency codes (decision D15) with their protocols per domain and the project crisis alerts. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/safety/emergency-codes">) {
  const page = await loadModulePage("safety.emergency-codes", await params, await searchParams);
  return <EmergencyCodesSection page={page} />;
}
