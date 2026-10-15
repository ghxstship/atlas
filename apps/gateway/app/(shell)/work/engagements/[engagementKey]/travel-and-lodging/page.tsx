import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab travel-and-lodging (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/travel-and-lodging">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.travel-and-lodging" engagementKey={engagementKey} />;
}
