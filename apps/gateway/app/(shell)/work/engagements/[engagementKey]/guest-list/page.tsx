import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab guest-list (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/guest-list">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.guest-list" engagementKey={engagementKey} />;
}
