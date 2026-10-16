import { requireNode } from "@/components/shell/sitemap-page";
import { TrainingSection } from "@/components/workforce/training";
import { nodeHref } from "@/lib/shell/sitemap";

/** Knowledge > Training (Section 4.9 Training). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/knowledge/training">) {
  const routeParams = await params;
  const ctx = await requireNode("knowledge.training", routeParams);
  return (
    <TrainingSection
      ctx={ctx}
      path={nodeHref("knowledge.training", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
