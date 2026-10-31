import {
  getLibrarySegment,
  listLibrarySegments,
  listSegmentCopies,
} from "@xos/data/segment-library";
import { getNode } from "@xos/ia";
import type { ReactNode } from "react";
import { collectionPeek } from "@/components/shell/collection-peek";
import { capabilitySet, must, nodeViews, param, type SearchParams } from "@/components/work/load";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { SegmentCollection, SegmentPeek } from "./segment-library";

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Show > Segment library (B3, G-73, ADR 0142): the org's reusable segments as a list or table; the peek edits a
 * segment's name, colour, description and cues with their department calls, and publishes its current version to
 * the running orders that hold a copy. Every member reads the library; editing it takes show.run_of_show.write
 * org-wide, which the database checks again.
 */
export async function SegmentLibraryPage({
  ctx,
  node,
  search,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
}) {
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  const view = requested && views.includes(requested) ? requested : defaultView;
  const [caps, segments] = await Promise.all([
    capabilitySet(ctx),
    listLibrarySegments(db, ctx.org.id),
  ]);
  const canEdit = caps.has("show.run_of_show.write");

  let peek: ReactNode = null;
  const peekId = param(search, "peek");
  if (peekId && UUID.test(peekId)) {
    const [segment, copies] = await Promise.all([
      getLibrarySegment(db, peekId),
      listSegmentCopies(db, peekId),
    ]);
    if (segment.ok) {
      peek = (
        <SegmentPeek
          org={ctx.org.slug}
          segment={segment.data}
          copies={must(copies, "segment copies")}
          canEdit={canEdit}
        />
      );
    } else if (segment.error.kind !== "not-found") {
      throw new Error(`Cannot load library segment: ${JSON.stringify(segment.error)}`);
    }
  }

  return (
    <SegmentCollection
      org={ctx.org.slug}
      title={t(getNode(sitemap, node).node.label)}
      segments={must(segments, "library segments")}
      views={views}
      view={view}
      canEdit={canEdit}
      creating={param(search, "create") === "1"}
      peek={collectionPeek(peekId, peek)}
    />
  );
}
