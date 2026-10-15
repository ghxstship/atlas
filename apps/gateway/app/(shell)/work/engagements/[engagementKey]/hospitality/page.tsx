import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab hospitality (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/hospitality">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.hospitality" engagementKey={engagementKey} />;
}
