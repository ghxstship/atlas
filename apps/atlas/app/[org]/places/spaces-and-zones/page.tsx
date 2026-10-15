import { SpacesPage } from "@/components/places/spaces/spaces-page";

/** Places > Spaces and zones (A09). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/places/spaces-and-zones">) {
  return <SpacesPage params={await params} search={await searchParams} />;
}
