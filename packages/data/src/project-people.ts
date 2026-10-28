import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Project people pickers (R1, migration 2600), imported as `@xos/data/project-people`. Forms that pick
 * a person on a project (badge holders, travellers, guests, per diem workers) read the org's members
 * and the people named on the project's live engagements through app.project_people; forms that pick
 * an engagement (the dock Vendor, the custodian, a cue's Set for) read app.engagement_options. The
 * database decides who reaches either: a people picker capability on the project.
 */

export type ExternalRoleType = Database["app"]["Enums"]["external_role_type"];
export type EngagementState = Database["app"]["Enums"]["engagement_state"];

/** A person a form on the project may pick: a member, an engaged person, or both. */
export interface ProjectPerson {
  readonly personId: string;
  readonly fullName: string;
  /** Current membership in the project's org; null for an engaged non-member. */
  readonly membershipId: string | null;
  /** The person's live engagement on the project, Active first; null for a member who has none. */
  readonly engagementId: string | null;
  readonly roleType: ExternalRoleType | null;
  readonly engagementState: EngagementState | null;
  /** Name of the account that supplies the person under the engagement. */
  readonly accountName: string | null;
}

/** A live engagement of a reachable project, for engagement selects. */
export interface EngagementOption {
  readonly engagementId: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly roleType: ExternalRoleType;
  readonly engagementState: EngagementState;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly accountName: string | null;
}

export async function listProjectPeople(
  db: XosClient,
  projectId: string,
): Promise<Result<ProjectPerson[]>> {
  const { data, error } = await db.rpc("project_people", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      personId: r.person_id,
      fullName: r.full_name,
      membershipId: r.membership_id ?? null,
      engagementId: r.engagement_id ?? null,
      roleType: r.role_type ?? null,
      engagementState: r.engagement_state ?? null,
      accountName: r.account_name ?? null,
    })),
  );
}

export async function listEngagementOptions(
  db: XosClient,
  scope: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<EngagementOption[]>> {
  const { data, error } = await db.rpc("engagement_options", {
    p_org_id: scope.orgId,
    ...(scope.projectId ? { p_project_id: scope.projectId } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      engagementId: r.engagement_id,
      projectId: r.project_id,
      projectKey: r.project_key,
      roleType: r.role_type,
      engagementState: r.engagement_state,
      personId: r.person_id ?? null,
      personName: r.person_name ?? null,
      accountName: r.account_name ?? null,
    })),
  );
}

/**
 * The membership or engagement a picked person comes with on the project. A person who is neither a
 * current member nor named on a live engagement is refused with person_not_on_project.
 */
export async function resolveProjectPerson(
  db: XosClient,
  projectId: string,
  personId: string,
): Promise<Result<{ membershipId: string | null; engagementId: string | null }>> {
  const people = await listProjectPeople(db, projectId);
  if (!people.ok) return people;
  const person = people.data.find((p) => p.personId === personId);
  if (!person) {
    return fail({
      kind: "refusal",
      rule: "person_not_on_project",
      message: "The person is neither a member nor engaged on the project.",
    });
  }
  return ok({ membershipId: person.membershipId, engagementId: person.engagementId });
}
