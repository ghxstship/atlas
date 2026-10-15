import { redirect } from "next/navigation";
import { loadEngagementView } from "@/lib/engagement";

/** Every engagement opens to Overview (Section 4.5.8). */
export default async function EngagementPage({
  params,
}: PageProps<"/work/engagements/[engagementKey]">) {
  const { engagementKey } = await params;
  await loadEngagementView(engagementKey);
  redirect(`/work/engagements/${engagementKey}/overview`);
}
