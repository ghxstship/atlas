/**
 * Which rating a dispute is about (ADR 0158), for the org that gave it and the person it is about. It comes from one RPC so
 * it survives an upheld dispute, which takes the rating out of every read: the party, project and date stay, and the score
 * and comment go.
 */
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

export interface RatingDisputeSubject {
  readonly orgName: string;
  readonly engagementId: string;
  readonly partyName: string | null;
  readonly projectName: string;
  /** Null once the dispute is upheld, and the rating with it. */
  readonly ratingScore: number | null;
  readonly ratingComment: string | null;
  readonly ratingSubmittedAt: string;
}

export async function readRatingDisputeSubjects(
  db: XosClient,
): Promise<Result<ReadonlyMap<string, RatingDisputeSubject>>> {
  const { data, error } = await db.rpc("rating_dispute_subjects");
  if (error) return fail(toDataError(error));
  return ok(
    new Map(
      data.map((row) => [
        row.dispute_id,
        {
          orgName: row.org_name,
          engagementId: row.engagement_id,
          partyName: row.party_name,
          projectName: row.project_name,
          ratingScore: row.rating_score,
          ratingComment: row.rating_comment,
          ratingSubmittedAt: row.rating_submitted_at,
        },
      ]),
    ),
  );
}
