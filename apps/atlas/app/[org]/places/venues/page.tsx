import { VenuesPage } from "@/components/places/venues/venues-page";

/** Places > Venues (A09). The view, peek, full page and create drawer live in the query string. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/places/venues">) {
  return <VenuesPage params={await params} search={await searchParams} />;
}
