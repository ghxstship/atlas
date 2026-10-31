import type { XosClient } from "./client.ts";
import { Constants, type Database } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Org rules set in Settings (A86, RRR-131, finding A65-004):
 *   * spend authority limits per role or member, document type and currency (0320, 0360; Section 4.5.6 org
 *     settings item 22), which the approval RPCs enforce;
 *   * the separation of duties rules the platform enforces for every org (0320, 1150; item 23), and the stricter
 *     options an org may switch on (2280, A135, ADR 0114);
 *   * custom field definitions and their choices on built-in tables (0540; item 16).
 * Writes are plain table writes under row level security (org.spend_authority.write, org.custom_fields.write) or,
 * for separation of duties options, app.set_separation_of_duties_option (org.separation_of_duties.write); the
 * guards refuse a limit that would apply to its own author (sod_self_grant), changing a field's type and switching
 * a built-in rule.
 */

export type SpendDocumentType = Database["app"]["Enums"]["spend_document_type"];
export const SPEND_DOCUMENT_TYPES: readonly SpendDocumentType[] =
  Constants.app.Enums.spend_document_type;

export interface SpendAuthority {
  readonly id: string;
  readonly roleId: string | null;
  readonly membershipId: string | null;
  readonly documentType: SpendDocumentType;
  readonly currencyCode: string;
  readonly limitMinor: number;
  readonly dualApprovalAboveMinor: number | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  /** Narrowed to one GL account or cost center; the panel shows these but does not create them. */
  readonly narrowed: boolean;
}

export async function listSpendAuthorities(
  db: XosClient,
  orgId: string,
): Promise<Result<SpendAuthority[]>> {
  const { data, error } = await db
    .from("spend_authorities")
    .select(
      "id, role_id, membership_id, document_type, currency_code, limit_minor, dual_approval_above_minor, valid_from, valid_to, account_code, cost_center_id",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("document_type")
    .order("limit_minor", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      roleId: r.role_id,
      membershipId: r.membership_id,
      documentType: r.document_type,
      currencyCode: r.currency_code,
      limitMinor: r.limit_minor,
      dualApprovalAboveMinor: r.dual_approval_above_minor,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      narrowed: r.account_code !== null || r.cost_center_id !== null,
    })),
  );
}

export interface SpendAuthorityInput {
  readonly orgId: string;
  /** Exactly one of a role and a membership holds the limit. */
  readonly holder: { readonly roleId: string } | { readonly membershipId: string };
  readonly documentType: SpendDocumentType;
  readonly currencyCode: string;
  readonly limitMinor: number;
  readonly dualApprovalAboveMinor: number | null;
}

export async function addSpendAuthority(
  db: XosClient,
  input: SpendAuthorityInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("spend_authorities")
    .insert({
      org_id: input.orgId,
      role_id: "roleId" in input.holder ? input.holder.roleId : null,
      membership_id: "membershipId" in input.holder ? input.holder.membershipId : null,
      document_type: input.documentType,
      currency_code: input.currencyCode,
      limit_minor: input.limitMinor,
      dual_approval_above_minor: input.dualApprovalAboveMinor,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a limit; a removed limit is revoked authority and cannot be restored from trash. */
export async function removeSpendAuthority(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("spend_authorities")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}

// Separation of duties ---------------------------------------------------------------------------------------

export interface SeparationRule {
  readonly code: string;
  readonly enforcedOn: string;
  readonly description: string;
}

/** Every rule the platform enforces, by code. No org can loosen them. */
export async function listSeparationRules(db: XosClient): Promise<Result<SeparationRule[]>> {
  const { data, error } = await db
    .from("separation_of_duties_rules")
    .select("code, enforced_on, description")
    .order("code");
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((r) =>
      r.code
        ? [{ code: r.code, enforcedOn: r.enforced_on ?? "", description: r.description ?? "" }]
        : [],
    ),
  );
}

export interface SeparationOption extends SeparationRule {
  /** The built-in rule the option tightens. */
  readonly tightens: string;
  /** Whether the org switched it on. */
  readonly on: boolean;
}

/**
 * The stricter options an org may switch on (2280, ADR 0114), each with whether this org has. Only options
 * switch; the built-in rules of `listSeparationRules` are always on.
 */
export async function listSeparationOptions(
  db: XosClient,
  orgId: string,
): Promise<Result<SeparationOption[]>> {
  const [options, chosen] = await Promise.all([
    db
      .from("separation_of_duties_options")
      .select("code, tightens, enforced_on, description")
      .order("code"),
    db
      .from("org_separation_of_duties_options")
      .select("rule_code")
      .eq("org_id", orgId)
      .is("deleted_at", null),
  ]);
  if (options.error) return fail(toDataError(options.error));
  if (chosen.error) return fail(toDataError(chosen.error));
  const on = new Set(chosen.data.map((r) => r.rule_code));
  return ok(
    options.data.flatMap((r) =>
      r.code
        ? [
            {
              code: r.code,
              tightens: r.tightens ?? "",
              enforcedOn: r.enforced_on ?? "",
              description: r.description ?? "",
              on: on.has(r.code),
            },
          ]
        : [],
    ),
  );
}

/**
 * Switches an option on or off (org.separation_of_duties.write). A built-in rule code is refused
 * (`separation_option_unknown`); repeating a choice changes nothing.
 */
export async function setSeparationOption(
  db: XosClient,
  orgId: string,
  code: string,
  on: boolean,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_separation_of_duties_option", {
    p_org_id: orgId,
    p_rule_code: code,
    p_on: on,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Custom fields ----------------------------------------------------------------------------------------------

export type CustomDataType = Database["app"]["Enums"]["custom_data_type"];
export const CUSTOM_DATA_TYPES: readonly CustomDataType[] = Constants.app.Enums.custom_data_type;

export interface CustomFieldChoice {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  /** The option's colour (cat-1 to cat-7, the themed categorical tokens), or null (2920). */
  readonly colorKey?: string | null;
}

interface ChoiceRow {
  id: string;
  choice_key: string;
  label: string;
  sort_order: number;
  color_key?: string | null;
  deleted_at: string | null;
}

/** A field's live choices in option order, with their colours. */
export function liveChoices(rows: readonly ChoiceRow[] | null): CustomFieldChoice[] {
  return (rows ?? [])
    .filter((c) => c.deleted_at === null)
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
    .map((c) => ({ id: c.id, key: c.choice_key, label: c.label, colorKey: c.color_key ?? null }));
}

export interface CustomField {
  readonly id: string;
  readonly targetTable: string;
  readonly key: string;
  readonly label: string;
  readonly dataType: CustomDataType;
  readonly required: boolean;
  readonly filterable: boolean;
  readonly sortOrder: number;
  readonly choices: readonly CustomFieldChoice[];
}

/** The built-in tables an org may add custom fields to (1433). */
export async function listCustomFieldTargets(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db.from("custom_field_targets").select("table_name");
  if (error) return fail(toDataError(error));
  return ok(data.flatMap((r) => (r.table_name ? [r.table_name] : [])).sort());
}

export async function listCustomFields(
  db: XosClient,
  orgId: string,
): Promise<Result<CustomField[]>> {
  // Untyped until the data types carry custom_field_choices.color_key (2920); rows are mapped here.
  const { data, error } = await untyped(db)
    .from("custom_field_definitions")
    .select(
      "id, target_table, field_key, label, data_type, required, filterable, sort_order, custom_field_choices(id, choice_key, label, sort_order, color_key, deleted_at)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("target_table")
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as unknown as DefinitionRow[]).map((r) => ({
      id: r.id,
      targetTable: r.target_table,
      key: r.field_key,
      label: r.label,
      dataType: r.data_type,
      required: r.required,
      filterable: r.filterable,
      sortOrder: r.sort_order,
      choices: liveChoices(r.custom_field_choices),
    })),
  );
}

/** A definition row with its choices, as the custom field readers select it. */
export interface DefinitionRow {
  id: string;
  target_table: string;
  field_key: string;
  label: string;
  data_type: CustomDataType;
  required: boolean;
  filterable: boolean;
  sort_order: number;
  custom_field_choices: ChoiceRow[] | null;
}

export interface CustomFieldInput {
  readonly orgId: string;
  readonly targetTable: string;
  readonly key: string;
  readonly label: string;
  readonly dataType: CustomDataType;
  readonly required: boolean;
  readonly filterable: boolean;
  readonly sortOrder: number;
}

export async function createCustomField(
  db: XosClient,
  input: CustomFieldInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("custom_field_definitions")
    .insert({
      org_id: input.orgId,
      target_table: input.targetTable,
      field_key: input.key,
      label: input.label,
      data_type: input.dataType,
      required: input.required,
      filterable: input.filterable,
      sort_order: input.sortOrder,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a field from every record of its table; stored values stay for the retention period. */
export async function removeCustomField(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("custom_field_definitions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}

export async function addCustomFieldChoice(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly fieldId: string;
    readonly key: string;
    readonly label: string;
    readonly sortOrder: number;
    /** cat-1 to cat-7, or null for no colour (2920). */
    readonly colorKey?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db)
    .from("custom_field_choices")
    .insert({
      org_id: input.orgId,
      custom_field_definition_id: input.fieldId,
      choice_key: input.key,
      label: input.label,
      sort_order: input.sortOrder,
      color_key: input.colorKey ?? null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

/** Sets or clears (null) a choice's colour; the database takes cat-1 to cat-7 only (2920). */
export async function setCustomFieldChoiceColor(
  db: XosClient,
  choiceId: string,
  colorKey: string | null,
): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("custom_field_choices")
    .update({ color_key: colorKey })
    .eq("id", choiceId)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data ?? []).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** A field key from a label: lowercase letters, digits and underscores, starting with a letter. */
export function fieldKeyFrom(label: string): string {
  const key = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");
  return key.slice(0, 48);
}
