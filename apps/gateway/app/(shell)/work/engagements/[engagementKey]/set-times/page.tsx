import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab set-times (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/set-times">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.set-times" engagementKey={engagementKey} />;
}
