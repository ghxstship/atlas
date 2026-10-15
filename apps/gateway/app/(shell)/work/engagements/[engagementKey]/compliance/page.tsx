import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab compliance (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/compliance">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.compliance" engagementKey={engagementKey} />;
}
