import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab proof-of-performance (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/proof-of-performance">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.proof-of-performance" engagementKey={engagementKey} />;
}
