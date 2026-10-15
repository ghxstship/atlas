/**
 * The contract audit (ADR 0023) reports each kind of mismatch between a resource and its table.
 */
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, uncorrectedFrozenCatalog } from "../src/app.ts";
import { SCHEMA_DUMP_SQL, auditCatalog } from "../src/catalog/schema-audit.ts";
import type { DumpColumn, SchemaDump } from "../src/catalog/schema-audit.ts";

const gateEvidence = uncorrectedFrozenCatalog.filter((s) => s.op === "gateEvidence");
const projects = uncorrectedFrozenCatalog.filter((s) => s.op === "projects");

function column(t: string, c: string, type: string, extra: Partial<DumpColumn> = {}): DumpColumn {
  return {
    s: "app",
    t,
    c,
    type,
    udt: type,
    udt_schema: "pg_catalog",
    nullable: false,
    default: null,
    generated: false,
    ...extra,
  };
}

const base = (t: string) => [
  column(t, "id", "uuid", { default: "private.uuid_v7()" }),
  column(t, "org_id", "uuid"),
  column(t, "created_at", "timestamp with time zone", { default: "now()" }),
  column(t, "created_by", "uuid", { nullable: true }),
  column(t, "updated_at", "timestamp with time zone", { default: "now()" }),
  column(t, "updated_by", "uuid", { nullable: true }),
];

const dump: SchemaDump = {
  kinds: { "app.gate_evidence": "r" },
  enums: {},
  columns: [
    ...base("gate_evidence"),
    column("gate_evidence", "project_id", "uuid"),
    column("gate_evidence", "criterion_id", "text"),
    column("gate_evidence", "record_id", "uuid", { nullable: true }),
    column("gate_evidence", "attested_by", "uuid", { nullable: true }),
    column("gate_evidence", "attested_at", "timestamp with time zone", { default: "now()" }),
    column("gate_evidence", "assertion_rank", "text"),
    column("gate_evidence", "evidence_uri", "text"),
    column("gate_evidence", "price_minor", "numeric", { nullable: true }),
  ],
};

describe("contract audit", () => {
  const [audit] = auditCatalog(gateEvidence, buildOpenApiDocument(gateEvidence), dump);
  const kinds = (kind: string) =>
    (audit?.findings ?? []).filter((f) => f.kind === kind).map((f) => f.field);

  it("reports nullability, names, types, create bodies and money", () => {
    expect(audit?.source).toBe("table");
    expect(kinds("audit_nullable")).toEqual(["created_by", "updated_by"]);
    expect(kinds("nullable")).toEqual(["attested_by"]);
    expect(kinds("missing_column")).toEqual(["evidence_document_id"]);
    expect(kinds("extra_column")).toEqual(["evidence_uri", "price_minor"]);
    expect(kinds("type")).toEqual(["assertion_rank"]);
    expect(kinds("create_missing")).toEqual(["evidence_uri"]);
    expect(kinds("create_overrequired")).toEqual(["attested_by", "attested_at"]);
    expect(audit?.findings.some((f) => f.kind === "money" && f.field === undefined)).toBe(true);
  });

  it("reports a resource whose table does not exist", () => {
    const [missing] = auditCatalog(projects, buildOpenApiDocument(projects), dump);
    expect(missing?.source).toBeNull();
    expect(missing?.findings).toEqual([{ kind: "unbuilt" }]);
  });

  it("reads the schema with one read-only query", () => {
    expect(SCHEMA_DUMP_SQL).toMatch(/^\s*select json_build_object/);
    expect(SCHEMA_DUMP_SQL).not.toMatch(/\b(insert|update|delete|alter|create|drop)\b/i);
  });
});
