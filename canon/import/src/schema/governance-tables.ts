import type { TableSpec } from "./types.ts";

/** Governance tables (Section 7.2): version, ratification, supersession, provenance and intake. */
export const GOVERNANCE_TABLES: readonly TableSpec[] = [
  {
    name: "version",
    comment:
      "Canon version and generation, with the hashes of the files the seed was generated from.",
    primaryKey: ["version_code"],
    columns: [
      { name: "version_code", type: "code", comment: "Canon version, such as 4.0." },
      {
        name: "generation",
        type: "int",
        comment: "Import generation; increases when a canon change ships.",
        check: "generation > 0",
      },
      {
        name: "bible_generated_at",
        type: "timestamp",
        comment: "generated_at stated in the Bible _generated tab.",
      },
      { name: "bible_sha256", type: "code", comment: "SHA-256 of the Bible workbook." },
      { name: "item_catalog_sha256", type: "code", comment: "SHA-256 of the Item Catalog CSV." },
      { name: "gl_chart_sha256", type: "code", comment: "SHA-256 of the GL chart CSV." },
      {
        name: "playbook_sha256",
        type: "code",
        comment: "SHA-256 of the Production Playbook workbook.",
      },
    ],
  },
  {
    name: "ratification",
    comment:
      "Ratification records. The 4.0 grammar is proposed until a named ratifier is recorded here (Section 3.13).",
    primaryKey: ["subject"],
    columns: [
      { name: "subject", type: "text", comment: "What is ratified, such as the 4.0 grammar." },
      { name: "ratifier", type: "text", comment: "Named human ratifier." },
      { name: "ratified_at", type: "timestamptz", comment: "When the ratification was recorded." },
      { name: "note", type: "text", nullable: true, comment: "Ratification note." },
    ],
  },
  {
    name: "supersession",
    comment:
      "Superseded codes and their successors. Supersession is data, so reverting is a data change; the graph stays acyclic.",
    primaryKey: ["domain", "code"],
    columns: [
      { name: "domain", type: "code", comment: "Code domain, such as phase." },
      {
        name: "code",
        type: "code",
        comment: "Superseded code; historical references keep resolving.",
      },
      { name: "successor_code", type: "code", comment: "Code that supersedes it." },
      { name: "label", type: "text", comment: "Label the superseded code carried." },
      { name: "reason", type: "text", comment: "Why the code was superseded." },
    ],
    checks: ["code <> successor_code"],
  },
  {
    name: "field_provenance",
    comment:
      "Provenance of every populated canon field of an element (Section 3.8). A lower rank never overwrites a field written by a higher rank.",
    primaryKey: ["element_id", "field_name"],
    columns: [
      {
        name: "element_id",
        type: "code",
        references: "elements(element_id)",
        comment: "Element whose field was written.",
      },
      { name: "field_name", type: "code", comment: "Column of xpms.elements that was written." },
      {
        name: "provenance",
        type: "code",
        references: "dim_provenance(provenance)",
        comment: "Provenance of the write.",
      },
      {
        name: "recorded_at",
        type: "timestamp",
        comment: "When the write was recorded (the Bible generation time for imported values).",
      },
    ],
  },
  {
    name: "intake",
    comment:
      "Staging for proposed canon additions and changes awaiting an owner decision. Neither source silently wins: a value that disagrees with canon or cannot be resolved waits here.",
    primaryKey: ["source_file", "source_sheet", "source_row", "source_column"],
    columns: [
      { name: "source_file", type: "text", comment: "Canon input file the value comes from." },
      { name: "source_sheet", type: "text", comment: "Sheet, tab or CSV the value comes from." },
      { name: "source_row", type: "int", comment: "Source row number." },
      { name: "source_column", type: "text", comment: "Source column header." },
      { name: "target_table", type: "code", comment: "xpms table the value would change." },
      { name: "target_key", type: "text", comment: "Natural key of the target row." },
      { name: "target_column", type: "code", comment: "Column the value would change." },
      {
        name: "proposed_value",
        type: "text",
        nullable: true,
        comment: "Value as the source states it; NULL when the source is blank.",
      },
      {
        name: "canon_value",
        type: "text",
        nullable: true,
        comment: "Value canon currently holds; NULL when canon is silent.",
      },
      { name: "reason", type: "text", comment: "Why the value is held for a decision." },
      {
        name: "intake_state",
        type: "text",
        references: "dim_state(state)",
        comment: "State of the proposal; Proposed until the owner decides.",
      },
    ],
  },
];
