import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab purchase-orders (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/purchase-orders">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.purchase-orders" engagementKey={engagementKey} />;
}
