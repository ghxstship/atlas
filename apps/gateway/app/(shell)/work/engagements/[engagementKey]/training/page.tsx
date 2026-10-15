import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab training (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/training">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.training" engagementKey={engagementKey} />;
}
