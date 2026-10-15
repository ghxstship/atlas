import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab offer (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/offer">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.offer" engagementKey={engagementKey} />;
}
