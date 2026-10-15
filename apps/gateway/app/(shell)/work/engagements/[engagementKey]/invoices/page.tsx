import { EngagementTabPage } from "@/components/engagement/engagement-tab";

/** Engagement tab invoices (Section 4.5.8); content and visibility come from the engagement view. */
export default async function Page({
  params,
}: PageProps<"/work/engagements/[engagementKey]/invoices">) {
  const { engagementKey } = await params;
  return <EngagementTabPage tab="engagement.invoices" engagementKey={engagementKey} />;
}
