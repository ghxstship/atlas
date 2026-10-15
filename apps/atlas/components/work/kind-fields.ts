import { Constants } from "@xos/data/database.types";
import {
  listCounterpartyOptions,
  listEnumerationOptions,
  listPermitRuleOptions,
  listRoleOptions,
  listUnitOptions,
  listVenueOptions,
  type CanonOption,
} from "@xos/data/work";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { must } from "./load";
import type { FieldType, KindField } from "./record-panels";

/**
 * The attributes each kind's extension table carries (migration 0311), with the input each one
 * takes. Labels come from the catalogs (`work.extension.<column>`); options for canon and org
 * references are loaded from their tables, never retyped.
 */
type Source =
  | "role"
  | "permitRule"
  | "inspectionResult"
  | "unit"
  | "counterparty"
  | "venue"
  | "direction"
  | "decision";

interface FieldSpec {
  readonly column: string;
  readonly type: FieldType;
  readonly source?: Source;
  readonly currencyColumn?: string;
}

const f = (column: string, type: FieldType, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  column,
  type,
  ...extra,
});

const KIND_FIELDS: Readonly<Record<string, readonly FieldSpec[]>> = {
  Build: [
    f("engineering_stamp_required", "boolean"),
    f("stamped_at", "datetime"),
    f("stamping_engineer", "text"),
  ],
  Rehearsal: [f("run_number", "number"), f("stream_target", "text")],
  Shift: [f("role_code", "select", { source: "role" }), f("headcount", "number")],
  Strike: [
    f("restoration_required", "boolean"),
    f("signed_off_at", "datetime"),
    f("signed_off_by", "person"),
  ],
  Task: [f("progress_pct", "number"), f("effort_hours", "number")],
  Training: [f("delivered_by", "person"), f("duration_minutes", "number")],
  Document: [f("storage_uri", "text"), f("version_label", "text")],
  Supply: [
    f("element_id", "text"),
    f("quantity", "number"),
    f("unit_basis", "select", { source: "unit" }),
    f("received_at", "datetime"),
  ],
  Booking: [
    f("counterparty_id", "select", { source: "counterparty" }),
    f("confirmation_identifier", "text"),
    f("quantity", "number"),
  ],
  Contract: [
    f("counterparty_id", "select", { source: "counterparty" }),
    f("currency_code", "currency"),
    f("value_minor", "money", { currencyColumn: "currency_code" }),
    f("signed_at", "datetime"),
    f("effective_from", "date"),
    f("effective_to", "date"),
  ],
  Payment: [
    f("counterparty_id", "select", { source: "counterparty" }),
    f("direction", "select", { source: "direction" }),
    f("currency_code", "currency"),
    f("amount_minor", "money", { currencyColumn: "currency_code" }),
  ],
  Recruitment: [
    f("role_code", "select", { source: "role" }),
    f("worker_classification", "text"),
    f("headcount", "number"),
  ],
  Approval: [
    f("requester_person_id", "readonly"),
    f("decision", "select", { source: "decision" }),
    f("approver_person_id", "readonly"),
    f("decided_at", "readonly"),
  ],
  Compliance: [f("valid_from", "date"), f("valid_to", "date"), f("on_file_at", "datetime")],
  Deadline: [f("owed_to", "text")],
  Decision: [
    f("options_considered", "longText"),
    f("decision_text", "longText"),
    f("decided_at", "datetime"),
    f("decided_by", "person"),
  ],
  Inspection: [
    f("result_enum_id", "select", { source: "inspectionResult" }),
    f("inspector_person_id", "person"),
    f("inspected_at", "datetime"),
  ],
  Permit: [
    f("permit_rule", "select", { source: "permitRule" }),
    f("permit_identifier", "text"),
    f("issued_at", "datetime"),
    f("expires_at", "datetime"),
  ],
  Distribution: [f("channel", "text"), f("audience", "text"), f("published_at", "datetime")],
  Event: [
    f("venue_id", "select", { source: "venue" }),
    f("doors_at", "datetime"),
    f("capacity", "number"),
  ],
  Goal: [
    f("metric", "text"),
    f("target_value", "number"),
    f("measured_value", "number"),
    f("unit_basis", "select", { source: "unit" }),
  ],
  Meeting: [f("location_text", "text"), f("conferencing_uri", "text")],
  Milestone: [f("achieved_at", "datetime")],
  Report: [f("period_start", "date"), f("period_end", "date"), f("published_at", "datetime")],
  Risk: [
    f("likelihood", "number"),
    f("impact", "number"),
    f("score", "readonly"),
    f("mitigation", "longText"),
  ],
  Timeline: [f("baseline_locked_at", "readonly")],
};

/** Values a kind's extension row needs on insert, where the table requires them. */
export function initialExtension(kind: string, personId: string | null): Record<string, string> {
  if (kind === "Approval" && personId) return { requester_person_id: personId };
  if (kind === "Payment") return { direction: Constants.app.Enums.money_direction[0] };
  return {};
}

/** The editable fields of a kind, with their options loaded. */
export async function kindFields(ctx: OrgContext, kind: string): Promise<KindField[]> {
  const specs = KIND_FIELDS[kind] ?? [];
  const db = ctx.viewer.db;
  const t = await getTranslate();
  const load = async (source: Source): Promise<CanonOption[]> => {
    switch (source) {
      case "role":
        return must(await listRoleOptions(db), "roles");
      case "permitRule":
        return must(await listPermitRuleOptions(db), "permit rules");
      case "inspectionResult":
        return must(await listEnumerationOptions(db, "Inspection Result"), "inspection results");
      case "unit":
        return must(await listUnitOptions(db), "units");
      case "counterparty":
        return must(await listCounterpartyOptions(db, ctx.org.id), "counterparties");
      case "venue":
        return must(await listVenueOptions(db, ctx.org.id), "venues");
      case "direction":
        return Constants.app.Enums.money_direction.map((d) => ({
          value: d,
          label: t(`work.enums.direction.${d}`),
        }));
      case "decision":
        return Constants.app.Enums.approval_decision.map((d) => ({
          value: d,
          label: t(`work.enums.decision.${d}`),
        }));
    }
  };
  return Promise.all(
    specs.map(async (spec) => ({
      column: spec.column,
      type: spec.type,
      ...(spec.currencyColumn ? { currencyColumn: spec.currencyColumn } : {}),
      ...(spec.source ? { options: await load(spec.source) } : {}),
    })),
  );
}
