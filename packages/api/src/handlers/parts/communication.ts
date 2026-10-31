/**
 * Needs review and Mark as communicated handlers (B6, RRR-230; catalog/modules/parts/communication.ts). Both run as
 * the caller through the RPCs of migration 2951, so the shift's own read policies and crew.shift.write on its project
 * decide. The status takes at most 100 ids in its query, since the ids travel in the URL; more are refused with the
 * rule the RPC uses for its own limit.
 */
import { listCommunicationStatus, markCommunicated } from "@xos/data/change-tracking";
import type { RequestContext } from "../../runtime/context.ts";
import { COMMUNICATION_STATUS_MAX_IDS } from "../../catalog/modules/parts/communication.ts";
import { problemFor, unwrap } from "../support/table.ts";

/** The communication status of the shifts named in `ids`, in the order asked, as a page without a cursor. */
export async function communicationStatus(context: RequestContext, ids: string) {
  const asked = [
    ...new Set(
      ids
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (asked.length > COMMUNICATION_STATUS_MAX_IDS) {
    throw problemFor({
      kind: "refusal",
      rule: "communication_too_many",
      message: `Ask for the communication status of at most ${COMMUNICATION_STATUS_MAX_IDS} shifts at a time.`,
    });
  }
  const status = unwrap(await listCommunicationStatus(context.db, asked));
  return {
    data: asked.flatMap((id) => {
      const s = status.get(id);
      return s
        ? [
            {
              shift_id: s.subjectId,
              person_id: s.personId,
              told_at: s.toldAt,
              told_via: s.toldVia,
              told_by_name: s.toldByName,
              changed_at: s.changedAt,
              changed_fields: [...s.changedFields],
              needs_review: s.needsReview,
            },
          ]
        : [];
    }),
    next_cursor: null,
  };
}

/** Marks the shifts as communicated; all or nothing. */
export async function markShiftsCommunicated(
  context: RequestContext,
  body: { readonly ids: readonly string[]; readonly note?: string | undefined },
) {
  return { marked: unwrap(await markCommunicated(context.db, body.ids, body.note ?? null)) };
}
