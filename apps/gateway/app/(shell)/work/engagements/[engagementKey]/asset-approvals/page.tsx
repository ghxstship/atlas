import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab asset-approvals (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/asset-approvals">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.asset-approvals" engagementKey={engagementKey} />;
}
