import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab time (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/time">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.time" engagementKey={engagementKey} />;
}
