import { PlansPage } from "@/components/places/plans/plans-page";

/** Places > Site plans (A09). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/places/site-plans">) {
  return <PlansPage params={await params} search={await searchParams} />;
}
