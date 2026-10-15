import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab run-of-show (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/run-of-show">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.run-of-show" engagementKey={engagementKey} />;
}
