import { SegmentLibraryPage } from "@/components/show/segment-library-page";
import { requireModuleNode } from "@/components/work/load";

/** Show > Segment library (B3, ADR 0142): the org's reusable segments, copied into running orders and republished. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/show/segments">) {
  const ctx = await requireModuleNode("show.segments", await params);
  return <SegmentLibraryPage ctx={ctx} node="show.segments" search={await searchParams} />;
}
