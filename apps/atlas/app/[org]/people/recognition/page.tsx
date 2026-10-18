import { requireNode } from "@/lib/shell/require-node";
import { RecognitionSection } from "@/components/workforce/recognition";
import { nodeHref } from "@/lib/shell/sitemap";

/** People > Recognition (Section 4.9 Recognition). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/people/recognition">) {
  const routeParams = await params;
  const ctx = await requireNode("people.recognition", routeParams);
  return (
    <RecognitionSection
      ctx={ctx}
      path={nodeHref("people.recognition", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
