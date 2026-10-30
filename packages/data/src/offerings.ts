import type { Database, XosClient } from "./client.ts";
import { Constants } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Offerings (R3, migrations 2620 to 2625, owner decision 7), imported as `@xos/data/offerings`. What
 * the producing org offers the people it engages: travel, lodging, catering, parking, uniforms, per
 * diem, radios, carts and a guest list, each Not Offered unless the org, the project or an audience
 * rule offers it. Gateway reads the resolved offerings of an engagement through
 * api_external.engagement_offerings; Atlas edits the audience rules in app.offering_rules, whose
 * policies require projects.settings.write. Removing a rule is a soft delete.
 */

export type OfferingKind = Database["app"]["Enums"]["offering_kind"];
export type OfferingMode = Database["app"]["Enums"]["offering_mode"];
export type ExternalRoleType = Database["app"]["Enums"]["external_role_type"];

/** Every offering, in the enum's order. */
export const OFFERING_KINDS: readonly OfferingKind[] = Constants.app.Enums.offering_kind;
/** Every mode, Not Offered first. */
export const OFFERING_MODES: readonly OfferingMode[] = Constants.app.Enums.offering_mode;

/** How one offering reaches an engagement, as the engaged party reads it. */
export interface EngagementOffering {
  readonly offering: OfferingKind;
  readonly mode: OfferingMode;
  readonly capPerEngagement: number | null;
  readonly capPerPerson: number | null;
}

export async function listEngagementOfferings(
  db: XosClient,
  engagementId: string,
): Promise<Result<EngagementOffering[]>> {
  const { data, error } = await db
    .schema("api_external")
    .from("engagement_offerings")
    .select("offering, offering_mode, cap_per_engagement, cap_per_person")
    .eq("engagement_id", engagementId);
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((r) =>
      r.offering === null || r.offering_mode === null
        ? []
        : [
            {
              offering: r.offering,
              mode: r.offering_mode,
              capPerEngagement: r.cap_per_engagement ?? null,
              capPerPerson: r.cap_per_person ?? null,
            },
          ],
    ),
  );
}

/** An audience rule of the org (projectId null) or of one project. */
export interface OfferingRule {
  readonly id: string;
  readonly projectId: string | null;
  readonly offering: OfferingKind;
  /** Null for every role type. */
  readonly roleType: ExternalRoleType | null;
  /** Null for every vendor class. */
  readonly vendorClassId: string | null;
  /** The class name, when the viewer reads vendor classes. */
  readonly vendorClassName: string | null;
  readonly mode: OfferingMode;
  readonly capPerEngagement: number | null;
  readonly capPerPerson: number | null;
}

const RULE_COLUMNS =
  "id, project_id, offering, external_role_type, vendor_class_id, offering_mode, cap_per_engagement, cap_per_person, vendor_classes(name)";

/** The live rules of the org (projectId null) or of one project, by offering. */
export async function listOfferingRules(
  db: XosClient,
  scope: { readonly orgId: string; readonly projectId: string | null },
): Promise<Result<OfferingRule[]>> {
  const base = db
    .from("offering_rules")
    .select(RULE_COLUMNS)
    .eq("org_id", scope.orgId)
    .is("deleted_at", null);
  const scoped =
    scope.projectId === null ? base.is("project_id", null) : base.eq("project_id", scope.projectId);
  const { data, error } = await scoped.order("offering").order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      id: r.id,
      projectId: r.project_id ?? null,
      offering: r.offering,
      roleType: r.external_role_type ?? null,
      vendorClassId: r.vendor_class_id ?? null,
      vendorClassName: r.vendor_classes?.name ?? null,
      mode: r.offering_mode,
      capPerEngagement: r.cap_per_engagement ?? null,
      capPerPerson: r.cap_per_person ?? null,
    })),
  );
}

export interface OfferingRuleInput {
  readonly orgId: string;
  readonly projectId: string | null;
  readonly offering: OfferingKind;
  readonly roleType: ExternalRoleType | null;
  readonly vendorClassId: string | null;
  readonly mode: OfferingMode;
  readonly capPerEngagement: number | null;
  readonly capPerPerson: number | null;
}

/** Adds a rule. A duplicate live audience comes back as a conflict, caps on Not Offered as invalid. */
export async function createOfferingRule(
  db: XosClient,
  input: OfferingRuleInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("offering_rules")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      offering: input.offering,
      external_role_type: input.roleType,
      vendor_class_id: input.vendorClassId,
      offering_mode: input.mode,
      cap_per_engagement: input.capPerEngagement,
      cap_per_person: input.capPerPerson,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a rule (a soft delete); a rule the viewer may not edit answers not-found. */
export async function removeOfferingRule(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("offering_rules")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if ((data ?? []).length === 0) return fail({ kind: "not-found" });
  return ok(null);
}
