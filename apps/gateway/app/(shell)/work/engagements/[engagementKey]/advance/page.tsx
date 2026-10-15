import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab advance (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/advance">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.advance" engagementKey={engagementKey} />;
}
