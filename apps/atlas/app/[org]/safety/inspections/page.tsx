import { InspectionsPage } from "@/components/safety/inspections/inspections-page";

/** Safety > Inspections (A09). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/safety/inspections">) {
  return <InspectionsPage params={await params} search={await searchParams} />;
}
