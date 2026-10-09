import type { ColumnSpec, ColumnType, TableSpec } from "../schema/types.ts";
import type { ColumnMap, FieldType, SheetEntry } from "./column-map.ts";
import { STD_TABLES } from "./column-map.ts";

/** Playbook registry and Production Template tables (Sections 2.1 and 7.2). */
export const PLAYBOOK_TABLES: readonly TableSpec[] = [
  {
    name: "playbook_sheet",
    comment:
      "Every sheet of the Production Playbook with its destination and manifest facts (canon/source/PLAYBOOK_MANIFEST.json).",
    primaryKey: ["sheet_name"],
    unique: [["sheet_key"], ["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "sheet_name", type: "text", comment: "Sheet name as the workbook spells it." },
      { name: "sheet_key", type: "code", comment: "snake_case key used in SQL object names." },
      {
        name: "ordinal",
        type: "int",
        comment: "Position of the sheet in the workbook.",
        check: "ordinal > 0",
      },
      {
        name: "destination",
        type: "code",
        comment: "canon-mirror, standard-library, production-template or template-metadata.",
        check:
          "destination in ('canon-mirror', 'standard-library', 'production-template', 'template-metadata')",
      },
      {
        name: "entity",
        type: "text",
        comment: "Target entity: an xpms table or the app table a later wave creates.",
      },
      {
        name: "header_row",
        type: "int",
        nullable: true,
        comment: "Header row; NULL for the Cover Page layout.",
      },
      {
        name: "used_range",
        type: "code",
        nullable: true,
        comment: "Range of cells holding values.",
      },
      {
        name: "data_row_count",
        type: "int",
        comment: "Data rows in the source sheet.",
        check: "data_row_count >= 0",
      },
      {
        name: "checksum_sha256",
        type: "code",
        comment: "SHA-256 of the normalized source cells; the round trip must reproduce it.",
      },
    ],
  },
  {
    name: "playbook_column",
    comment:
      "The Playbook column map (canon/map/playbook-columns.yaml): every column of every sheet with one disposition.",
    primaryKey: ["sheet_name", "ordinal"],
    unique: [["sheet_name", "column_key"]],
    columns: [
      {
        name: "sheet_name",
        type: "text",
        references: "playbook_sheet(sheet_name)",
        comment: "Sheet.",
      },
      { name: "ordinal", type: "int", comment: "Column position, 1 for A.", check: "ordinal > 0" },
      { name: "letter", type: "code", comment: "Column letters." },
      {
        name: "header",
        type: "text",
        nullable: true,
        comment: "Header text; NULL for Cover Page columns, which have no header row.",
      },
      { name: "column_key", type: "code", comment: "snake_case key of the column." },
      {
        name: "disposition",
        type: "code",
        comment: "field, computed or presentation.",
        check: "disposition in ('field', 'computed', 'presentation')",
      },
      {
        name: "target",
        type: "text",
        nullable: true,
        comment: "schema.table.column the column lands in or feeds.",
      },
      {
        name: "data_type",
        type: "code",
        nullable: true,
        comment: "Data type of the target field.",
      },
      {
        name: "note",
        type: "text",
        nullable: true,
        comment: "Transform, source formula or presentation reason.",
      },
    ],
  },
  {
    name: "production_template",
    comment:
      "The XOS 4.0 Production Template. Applying it creates a project with its records. Private to the owner's org until the owner approves publishing (Section 2.1).",
    primaryKey: ["template_code"],
    columns: [
      { name: "template_code", type: "code", comment: "Template code." },
      { name: "name", type: "text", comment: "Template name." },
      {
        name: "source_file",
        type: "text",
        comment: "Playbook file the template was imported from.",
      },
      { name: "source_sha256", type: "code", comment: "SHA-256 of that file." },
      {
        name: "is_published",
        type: "bool",
        comment: "True once the owner approves publishing to other tenants; false at import.",
      },
    ],
  },
  {
    name: "production_template_metadata",
    comment:
      "Cover Page cells: the template's metadata, at their source row and column. A formula cell keeps its evaluated value beside its formula.",
    primaryKey: ["template_code", "source_row", "column_ordinal"],
    columns: [
      {
        name: "template_code",
        type: "code",
        references: "production_template(template_code)",
        comment: "Template.",
      },
      { name: "source_row", type: "int", comment: "Cover Page row.", check: "source_row > 0" },
      {
        name: "column_ordinal",
        type: "int",
        comment: "Cover Page column, 1 for A.",
        check: "column_ordinal > 0",
      },
      {
        name: "value_text",
        type: "text",
        nullable: true,
        comment: "Value in lossless text form; NULL for a formula that evaluates to nothing.",
      },
      {
        name: "value_kind",
        type: "code",
        comment: "Kind of the value: string, number, boolean, date, datetime, time or empty.",
      },
      {
        name: "formula",
        type: "text",
        nullable: true,
        comment: "Formula source, for a formula cell.",
      },
    ],
  },
  {
    name: "production_template_rows",
    comment:
      "Every data row of the 27 record-template sheets, keyed by sheet and source row number.",
    primaryKey: ["template_code", "sheet_name", "source_row"],
    columns: [
      {
        name: "template_code",
        type: "code",
        references: "production_template(template_code)",
        comment: "Template.",
      },
      {
        name: "sheet_name",
        type: "text",
        references: "playbook_sheet(sheet_name)",
        comment: "Source sheet.",
      },
      {
        name: "source_row",
        type: "int",
        comment: "Row number in the source sheet.",
        check: "source_row > 1",
      },
    ],
  },
  {
    name: "production_template_values",
    comment:
      "Literal cell values of template rows. Formula columns are not stored; their views compute them (Section 3.15).",
    primaryKey: ["template_code", "sheet_name", "source_row", "column_ordinal"],
    foreignKeys: [
      {
        columns: ["template_code", "sheet_name", "source_row"],
        table: "production_template_rows",
        targets: ["template_code", "sheet_name", "source_row"],
      },
      {
        columns: ["sheet_name", "column_ordinal"],
        table: "playbook_column",
        targets: ["sheet_name", "ordinal"],
      },
    ],
    columns: [
      { name: "template_code", type: "code", comment: "Template." },
      { name: "sheet_name", type: "text", comment: "Source sheet." },
      { name: "source_row", type: "int", comment: "Row number in the source sheet." },
      { name: "column_ordinal", type: "int", comment: "Column position, 1 for A." },
      {
        name: "value_text",
        type: "text",
        comment:
          "Value in lossless text form: ISO dates, shortest round-trip numbers, TRUE or FALSE.",
      },
      {
        name: "value_kind",
        type: "code",
        comment: "Kind of the source value.",
        check: "value_kind in ('string', 'number', 'boolean', 'date', 'datetime', 'time')",
      },
    ],
  },
];

const FIELD_TYPES: Readonly<Record<Exclude<FieldType, "money">, ColumnType>> = {
  text: "text",
  code: "code",
  numeric: "numeric",
  int: "int",
  bool: "bool",
  date: "date",
  timestamp: "timestamp",
  time: "time",
};

/** Seeded column name of a Standard Library field (money is stored as minor units). */
export function stdColumnName(key: string, type: FieldType | undefined): string {
  return type === "money" ? `${key}_minor` : key;
}

/** Table spec of a Standard Library sheet, derived from its column map entry. */
export function stdTableSpec(entry: SheetEntry): TableSpec {
  const name = STD_TABLES[entry.sheet];
  if (!name) throw new Error(`${entry.sheet} is not a Standard Library sheet`);
  const fields = entry.columns.filter((c) => c.disposition === "field");
  const keyColumn = fields[0];
  if (!keyColumn) throw new Error(`${entry.sheet} has no field columns`);
  const columns: ColumnSpec[] = [
    {
      name: "source_row",
      type: "int",
      comment: `Row of the Playbook ${entry.sheet} sheet the entry was imported from; the library's default order.`,
      check: "source_row > 1",
    },
  ];
  for (const c of fields) {
    const money = c.type === "money";
    columns.push({
      name: stdColumnName(c.key, c.type),
      type:
        c.type === undefined || c.type === "money"
          ? money
            ? "minor"
            : "text"
          : FIELD_TYPES[c.type],
      nullable: c !== keyColumn,
      comment: `${c.header} from the Playbook ${entry.sheet} sheet${money ? ", in minor units of currency_code" : ""}.`,
    });
  }
  if (fields.some((c) => c.type === "money")) {
    columns.push({
      name: "currency_code",
      type: "currency",
      comment: "ISO 4217 currency of the amounts; the Playbook states US dollars.",
    });
  }
  return {
    name,
    comment: `XOS Standard Library: ${entry.sheet} (Playbook, provenance imported). Each new org receives an editable copy at creation.`,
    primaryKey: [keyColumn.key],
    unique: [["source_row"]],
    orderBy: ["source_row"],
    columns,
  };
}

export function stdTableSpecs(map: ColumnMap): TableSpec[] {
  return map.sheets
    .filter((s) => s.destination === "standard-library" && STD_TABLES[s.sheet] !== undefined)
    .map(stdTableSpec);
}
