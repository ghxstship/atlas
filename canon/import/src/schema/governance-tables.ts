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
      "Staging for proposed canon additions and changes. Neither source silently wins: a value that disagrees with canon or cannot be resolved waits here as Proposed until the owner decides. A Playbook value an owner decision does not adopt stays here as Canceled, so the Playbook round trip still reproduces the source; an adopted value leaves intake for canon and xpms.playbook_sourced_value.",
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
      {
        name: "reason",
        type: "text",
        comment: "Why the value is held, and for a decided value the decision that settled it.",
      },
      {
        name: "intake_state",
        type: "text",
        references: "dim_state(state)",
        comment:
          "State of the proposal: Proposed until the owner decides; Canceled when a decision keeps canon's value.",
      },
    ],
  },
  {
    name: "playbook_sourced_value",
    comment:
      "Canon values imported from the Production Playbook because the Bible states none (owner decision 25, 2026-10-19). Each row marks one stored value as Playbook-sourced so it can be reviewed later; wherever the Bible states a value, canon keeps the Bible's.",
    primaryKey: ["target_table", "target_key", "target_column"],
    columns: [
      { name: "target_table", type: "code", comment: "xpms table holding the imported value." },
      { name: "target_key", type: "text", comment: "Natural key of the row holding the value." },
      {
        name: "target_column",
        type: "code",
        comment:
          "Column holding the value; for a price band, amount_minor and the grade (amount_minor:base).",
      },
      {
        name: "value_text",
        type: "text",
        comment:
          "The value as the Playbook states it (a price in currency units, not minor units).",
      },
      { name: "source_file", type: "text", comment: "Playbook workbook the value comes from." },
      { name: "source_sheet", type: "text", comment: "Playbook sheet the value comes from." },
      { name: "source_row", type: "int", comment: "Playbook row the value comes from." },
      { name: "source_column", type: "text", comment: "Playbook column header." },
      { name: "decision", type: "code", comment: "Owner decision that imported the value (D25)." },
    ],
  },
  {
    name: "label_mapping",
    comment:
      "Playbook labels that are not canon values, each mapped to the closest existing canon or lifecycle value (owner decision 25, 2026-10-19). The Bible wins on structure, so no state, code or list entry is added; a label the decision does not cover has no canon value and basis deferred.",
    primaryKey: ["source_list", "playbook_label"],
    columns: [
      {
        name: "source_list",
        type: "text",
        comment:
          "Where the label appears: an Enumerations domain, a Bible-mirrored sheet, or the Production Template sheet and column.",
      },
      { name: "playbook_label", type: "text", comment: "The label as the Playbook states it." },
      {
        name: "target_domain",
        type: "code",
        comment:
          "Vocabulary the label maps into: state (canon states), unit, element_kind, counterparty_type, order_type, freight_type, record_kind, record_subtype, phase, department, category, or an app lifecycle (production_state, work_order_state, asset_state, shift_state).",
      },
      {
        name: "canon_value",
        type: "text",
        nullable: true,
        comment:
          "The existing value the label maps to (a record subtype as kind · subtype); NULL when the decision does not cover it.",
      },
      {
        name: "basis",
        type: "code",
        comment:
          "Why: casing-or-punctuation, same-label, closest-state, closest-value, not-added (a Playbook-only row) or deferred.",
        check:
          "basis in ('casing-or-punctuation', 'same-label', 'closest-state', 'closest-value', 'not-added', 'deferred')",
      },
      { name: "decision", type: "code", comment: "Owner decision that set the mapping (D25)." },
      { name: "note", type: "text", nullable: true, comment: "Reasoning for the mapping." },
    ],
    checks: ["(basis = 'deferred') = (canon_value is null)"],
  },
];
