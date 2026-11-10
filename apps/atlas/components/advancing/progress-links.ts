import type { AdvanceProgressCell } from "@xos/data/advancing";

/**
 * Where a Packets cell of Advancing > Progress opens: the answer, or the packet while there is none. The submissions
 * queue shows unreviewed answers by default, so a reviewed answer opens with the filter that holds it, or the queue
 * would select someone else's.
 */
export function progressCellHref(
  path: string,
  cell: Pick<AdvanceProgressCell, "latestSubmissionId" | "state" | "packetId">,
): string {
  if (!cell.latestSubmissionId) return `${path}?section=packets&peek=${cell.packetId}`;
  const filter = cell.state === "Awaiting Review" ? "" : "&filter=all";
  return `${path}?section=submissions${filter}&peek=${cell.latestSubmissionId}`;
}
