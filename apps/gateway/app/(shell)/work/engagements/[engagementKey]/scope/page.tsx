import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab scope (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/scope">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.scope" engagementKey={engagementKey} />;
}
