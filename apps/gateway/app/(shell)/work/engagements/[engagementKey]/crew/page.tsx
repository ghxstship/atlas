import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab crew (R4, ADR 0100); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/crew">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.crew" engagementKey={engagementKey} />;
}
