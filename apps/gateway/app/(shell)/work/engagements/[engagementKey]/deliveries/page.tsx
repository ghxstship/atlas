import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab deliveries (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/deliveries">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.deliveries" engagementKey={engagementKey} />;
}
