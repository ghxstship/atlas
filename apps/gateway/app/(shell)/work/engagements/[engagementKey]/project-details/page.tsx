import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab project-details (R5, ADR 0100); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/project-details">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.project-details" engagementKey={engagementKey} />;
}
