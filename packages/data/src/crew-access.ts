import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Crew access links, the Atlas side (B10, G-125, ADR 0149 decision 2): a crew lead issues a worker a token and a 6-digit
 * code that open their own shifts on one project in Gateway. The token and code come back once; the page holds them only
 * until the person closes the result. The worker's side is in gateway-public.ts.
 */

export type CrewAccessLinkStatus = "Live" | "Locked" | "Expired" | "Revoked" | "Closed";

/** One worker a link names: exactly one column, as app.shifts names a worker. */
export type CrewAccessWorkerRef =
  | { readonly membership_id: string }
  | { readonly engagement_id: string }
  | { readonly roster_entry_id: string };

export interface CrewAccessLink {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly personName: string | null;
  readonly expiresAt: string | null;
  readonly lastOpenedAt: string | null;
  readonly openCount: number;
  readonly status: CrewAccessLinkStatus;
}

export async function listCrewAccessLinks(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<CrewAccessLink[]>> {
  let query = db
    .from("crew_access_link_list")
    .select("id, project_id, project_name, person_name, expires_at, last_opened_at, open_count, link_status")
    .eq("org_id", input.orgId)
    .order("expires_at", { ascending: false })
    .limit(500);
  if (input.projectId) query = query.eq("project_id", input.projectId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      projectName: r.project_name,
      personName: r.person_name,
      expiresAt: r.expires_at,
      lastOpenedAt: r.last_opened_at,
      openCount: r.open_count ?? 0,
      status: r.link_status as CrewAccessLinkStatus,
    })),
  );
}

export interface CrewAccessWorker {
  readonly ref: CrewAccessWorkerRef;
  readonly personName: string;
  readonly nextShiftStartsAt: string;
  readonly timeZone: string;
  readonly hasLiveLink: boolean;
}

export async function listCrewAccessWorkers(db: XosClient, projectId: string): Promise<Result<CrewAccessWorker[]>> {
  const { data, error } = await db.rpc("crew_access_workers", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((w) => {
      const ref: CrewAccessWorkerRef | null = w.membership_id
        ? { membership_id: w.membership_id }
        : w.engagement_id
          ? { engagement_id: w.engagement_id }
          : w.roster_entry_id
            ? { roster_entry_id: w.roster_entry_id }
            : null;
      return ref
        ? [
            {
              ref,
              personName: w.person_name,
              nextShiftStartsAt: w.next_shift_starts_at,
              timeZone: w.time_zone,
              hasLiveLink: w.has_live_link,
            },
          ]
        : [];
    }),
  );
}

export interface IssuedCrewAccessLink {
  readonly linkId: string;
  readonly personName: string | null;
  readonly token: string;
  readonly accessCode: string;
  readonly expiresAt: string;
  /** The org's verified custom Gateway host, or null for the platform Gateway. */
  readonly gatewayHost: string | null;
}

export async function issueCrewAccessLinks(
  db: XosClient,
  input: { readonly projectId: string; readonly workers: readonly CrewAccessWorkerRef[]; readonly validForDays: number },
): Promise<Result<IssuedCrewAccessLink[]>> {
  const { data, error } = await db.rpc("issue_crew_access_links", {
    p_project_id: input.projectId,
    p_workers: [...input.workers],
    p_valid_for: `${input.validForDays} days`,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((l) => ({
      linkId: l.link_id,
      personName: l.person_name,
      token: l.token,
      accessCode: l.access_code,
      expiresAt: l.expires_at,
      gatewayHost: l.gateway_host,
    })),
  );
}

export async function revokeCrewAccessLink(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_crew_access_link", { p_link_id: id });
  if (error) return fail(toDataError(error));
  return ok(null);
}
