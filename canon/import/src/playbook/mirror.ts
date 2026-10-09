import type { SqlRow } from "../sql.ts";
import { fromMinorUnits } from "../model/values.ts";

/**
 * How each column of a Bible-mirrored Playbook sheet relates to canon
 * (Section 2.1). A canon column is cross-checked value by value; a Playbook
 * column has no Bible counterpart and is stored on the canon row.
 */

export interface MirrorContext {
  readonly tables: ReadonlyMap<string, readonly SqlRow[]>;
  /** Canon values the CSV states but xpms holds in intake (unresolved default phases). */
  readonly csvIntake: ReadonlyMap<string, string | null>;
}

export type MirrorColumn =
  | {
      readonly kind: "canon";
      /** Table and column whose value the Playbook cell must equal (the intake target). */
      readonly table: string;
      readonly column: string;
      /** Canon value for the mirrored row; defaults to the row's own column. */
      readonly read?: (row: SqlRow, ctx: MirrorContext) => string | null;
    }
  | { readonly kind: "playbook"; readonly column: string }
  | { readonly kind: "account-type-balance" };

export interface MirrorSpec {
  readonly sheet: string;
  readonly table: string;
  /** Header of the Playbook column that identifies the canon row. */
  readonly keyHeader: string;
  /** Canon column holding that identity. */
  readonly keyColumn: string;
  readonly columns: Readonly<Record<string, MirrorColumn>>;
}

const META: Readonly<Record<string, MirrorColumn>> = {
  STATUS: { kind: "playbook", column: "source_status" },
  "CREATED BY": { kind: "playbook", column: "source_created_by" },
  "CREATED AT": { kind: "playbook", column: "source_created_at" },
  "UPDATED AT": { kind: "playbook", column: "source_updated_at" },
};

function find(ctx: MirrorContext, table: string, key: string, value: unknown): SqlRow | undefined {
  return ctx.tables.get(table)?.find((r) => r[key] === value);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const own = (table: string, column: string): MirrorColumn => ({ kind: "canon", table, column });

export const MIRRORS: readonly MirrorSpec[] = [
  {
    sheet: "Departments",
    table: "dim_department",
    keyHeader: "CLASS CODE",
    keyColumn: "dept_code",
    columns: {
      "CLASS CODE": own("dim_department", "dept_code"),
      "DEPARTMENT NAME": own("dim_department", "department"),
      "EXECUTIVE LEAD": { kind: "playbook", column: "executive_lead" },
      "CORE FUNCTION": { kind: "playbook", column: "core_function" },
      SCOPE: { kind: "playbook", column: "scope" },
      ...META,
    },
  },
  {
    sheet: "Disciplines",
    table: "dim_discipline",
    keyHeader: "DISCIPLINE CODE",
    keyColumn: "disc_code",
    columns: {
      "DISCIPLINE CODE": own("dim_discipline", "disc_code"),
      "DISCIPLINE NAME": own("dim_discipline", "discipline"),
      "DEPARTMENT CLASS": own("dim_discipline", "dept_code"),
      DESCRIPTION: own("dim_discipline", "source"),
      ...META,
    },
  },
  {
    sheet: "Categories & URID Master",
    table: "dim_category",
    keyHeader: "URID",
    keyColumn: "cat_urid",
    columns: {
      URID: own("dim_category", "cat_urid"),
      DEPARTMENT: {
        kind: "canon",
        table: "dim_department",
        column: "department",
        read: (row, ctx) =>
          str(
            find(ctx, "dim_department", "dept_code", str(row["cat_urid"])?.slice(0, 4))?.[
              "department"
            ],
          ),
      },
      DISCIPLINE: {
        kind: "canon",
        table: "dim_discipline",
        column: "discipline",
        read: (row, ctx) =>
          str(find(ctx, "dim_discipline", "disc_code", row["disc_code"])?.["discipline"]),
      },
      CATEGORY: own("dim_category", "category"),
      "DEFAULT COST CENTER": {
        kind: "canon",
        table: "dim_category_gl",
        column: "default_cost_center",
        read: (row, ctx) =>
          str(find(ctx, "dim_category_gl", "cat_urid", row["cat_urid"])?.["default_cost_center"]),
      },
      "DEFAULT GL ACCOUNT": {
        kind: "canon",
        table: "v_category_gl",
        column: "account_code",
        read: (row, ctx) => {
          const cls = str(row["cat_urid"])?.slice(0, 1);
          const a = ctx.tables
            .get("dim_gl_account")
            ?.find(
              (x) => x["account_type"] === "Expense" && str(x["account_code"])?.slice(1, 2) === cls,
            );
          return str(a?.["account_code"]);
        },
      },
      "SCHEMA FAMILY (XYZ)": { kind: "playbook", column: "xyz" },
      ...META,
    },
  },
  {
    sheet: "GL Accounts",
    table: "dim_gl_account",
    keyHeader: "ACCOUNT CODE",
    keyColumn: "account_code",
    columns: {
      "ACCOUNT CODE": own("dim_gl_account", "account_code"),
      "ACCOUNT NAME": own("dim_gl_account", "account_name"),
      "ACCOUNT TYPE": own("dim_gl_account", "account_type"),
      "TAX TYPE": own("dim_gl_account", "tax_type"),
      "NORMAL BALANCE": { kind: "account-type-balance" },
      DESCRIPTION: own("dim_gl_account", "description"),
      ...META,
    },
  },
  {
    sheet: "Cost Centers",
    table: "dim_cost_center_template",
    keyHeader: "COST CENTER CODE",
    keyColumn: "cost_center_id",
    columns: {
      "COST CENTER CODE": own("dim_cost_center_template", "cost_center_id"),
      "COST CENTER NAME": own("dim_cost_center_template", "cost_center"),
      DIMENSION: own("dim_cost_center_template", "kind"),
      "SCOPE CODE": own("dim_cost_center_template", "scope_code"),
      "ALLOCATION SCOPE": own("dim_cost_center_template", "note"),
      ...META,
    },
  },
  {
    sheet: "Teams",
    table: "dim_team",
    keyHeader: "TEAM CODE",
    keyColumn: "team_id",
    columns: {
      "TEAM CODE": own("dim_team", "team_id"),
      "TEAM NAME": own("dim_team", "team"),
      "WORKGROUP TAG": { kind: "playbook", column: "workgroup_tag" },
      "DEPARTMENT CLASS": own("dim_team", "dept_code"),
      "LEAD ROLE": { kind: "playbook", column: "lead_role" },
      RESPONSIBILITIES: { kind: "playbook", column: "responsibilities" },
      ...META,
    },
  },
  {
    sheet: "Counterparty Types",
    table: "dim_counterparty_type",
    keyHeader: "COUNTERPARTY TYPE",
    keyColumn: "counterparty_type",
    columns: {
      "CLASSIFICATION CODE": { kind: "playbook", column: "classification_code" },
      "COUNTERPARTY TYPE": own("dim_counterparty_type", "counterparty_type"),
      "VENDOR CLASS": { kind: "playbook", column: "vendor_class" },
      "CLEARANCE TIER": { kind: "playbook", column: "clearance_tier" },
      "COMPLIANCE REQUIREMENTS": own("dim_counterparty_type", "definition"),
      "DEFAULT GL ACCOUNT": { kind: "playbook", column: "default_account_code" },
      ...META,
    },
  },
  {
    sheet: "Procurement Catalog",
    table: "elements",
    keyHeader: "ITEM ID",
    keyColumn: "element_id",
    columns: {
      "ITEM ID": own("elements", "element_id"),
      URID: own("elements", "urid"),
      "ITEM NAME": own("elements", "item"),
      "RESOURCE KIND": own("elements", "kind"),
      "SCHEMA FAMILY (XYZ)": own("elements", "xyz"),
      "DEFAULT GL ACCOUNT": {
        kind: "canon",
        table: "elements",
        column: "purchase_account",
        read: (row) => str(row["purchase_account"]) ?? str(row["sales_account"]),
      },
      "DEFAULT GL NAME": {
        kind: "canon",
        table: "dim_gl_account",
        column: "account_name",
        read: (row, ctx) =>
          str(
            find(
              ctx,
              "dim_gl_account",
              "account_code",
              str(row["purchase_account"]) ?? str(row["sales_account"]),
            )?.["account_name"],
          ),
      },
      "DEFAULT COST CENTER": own("elements", "default_cost_center"),
      "UNIT OF MEASURE": own("elements", "unit_basis"),
      "GRADE 1 BASIC ($ LOW)": band("base"),
      "GRADE 2 STANDARD ($ COST)": band("elevated"),
      "GRADE 3 PREMIUM ($ HIGH)": band("premium"),
      DESCRIPTION: own("elements", "description"),
      SPECIFICATIONS: own("elements", "specification"),
      "LEAD TIME (HRS)": own("elements", "lead_time_hours"),
      TIER: {
        kind: "canon",
        table: "elements",
        column: "tier_code",
        read: (row, ctx) => {
          const t = find(ctx, "dim_tier", "tier_code", row["tier_code"]);
          return t ? `${str(t["tier_code"]) ?? ""} ${str(t["tier"]) ?? ""}` : null;
        },
      },
      "DEFAULT PHASE": {
        kind: "canon",
        table: "bridge_element_phase",
        column: "phase_code",
        read: (row, ctx) => {
          const id = str(row["element_id"]) ?? "";
          if (ctx.csvIntake.has(id)) return ctx.csvIntake.get(id) ?? null;
          const b = ctx.tables
            .get("bridge_element_phase")
            ?.find((x) => x["element_id"] === id && x["is_default"] === true);
          return str(find(ctx, "dim_phase", "phase_code", b?.["phase_code"])?.["phase"]);
        },
      },
      "EXTERNAL REF": own("elements", "external_ref"),
    },
  },
];

function band(grade: string): MirrorColumn {
  return {
    kind: "canon",
    table: "element_price_bands",
    column: `amount_minor:${grade}`,
    read: (row, ctx) => {
      const b = ctx.tables
        .get("element_price_bands")
        ?.find((x) => x["element_id"] === row["element_id"] && x["grade_code"] === grade);
      const minor = str(b?.["amount_minor"]);
      return minor === null ? null : fromMinorUnits(minor);
    },
  };
}

export function mirrorFor(sheet: string): MirrorSpec {
  const m = MIRRORS.find((x) => x.sheet === sheet);
  if (!m) throw new Error(`No mirror specification for sheet ${sheet}`);
  return m;
}
