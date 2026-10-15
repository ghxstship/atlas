/**
 * The edits a contract correction applies (ADR 0023): they follow `defineResource`, keep component
 * ids and never mutate the frozen definition.
 */
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, uncorrectedFrozenCatalog } from "../src/app.ts";
import { fields } from "@xos/schemas";
import {
  all,
  editShape,
  orNull,
  putActions,
  removeActions,
  removeVerbs,
  setOrder,
} from "../src/catalog/correct.ts";
import { itemAction } from "../src/catalog/define.ts";
import type { ResourceSpec } from "../src/catalog/types.ts";

type Json = Record<string, unknown>;
type Doc = {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
};

const gateEvidence = uncorrectedFrozenCatalog.find((s) => s.op === "gateEvidence") as ResourceSpec;
const projects = uncorrectedFrozenCatalog.find((s) => s.op === "projects") as ResourceSpec;

function docOf(spec: ResourceSpec): Doc {
  return JSON.parse(JSON.stringify(buildOpenApiDocument([spec]))) as Doc;
}

function schema(doc: Doc, name: string): { properties: Record<string, Json>; required?: string[] } {
  return doc.components.schemas[name] as { properties: Record<string, Json>; required?: string[] };
}

describe("correction edits", () => {
  it("makes a field nullable in the read shape and optional on create", () => {
    const doc = docOf(editShape({ nullable: ["attested_by"] })(gateEvidence));
    expect(schema(doc, "GateEvidence").properties["attested_by"]?.["type"]).toEqual([
      "string",
      "null",
    ]);
    expect(schema(doc, "GateEvidence").required).toContain("attested_by");
    expect(schema(doc, "GateEvidenceCreate").required).not.toContain("attested_by");
    expect(schema(doc, "GateEvidenceUpdate").properties["attested_by"]?.["type"]).toEqual([
      "string",
      "null",
    ]);
  });

  it("makes a component field nullable without changing the shared component", () => {
    const before = docOf(projects).components.schemas["TierCode"];
    const doc = docOf(editShape({ nullable: ["tier_code"] })(projects));
    expect(doc.components.schemas["TierCode"]).toEqual(before);
    expect(schema(doc, "Project").properties["tier_code"]).toEqual({
      anyOf: [{ $ref: "#/components/schemas/TierCode" }, { type: "null" }],
    });
    expect(schema(doc, "ProjectCreate").required).not.toContain("tier_code");
  });

  it("adds, renames, removes and server-sets fields", () => {
    const edited = editShape({
      remove: ["evidence_document_id"],
      rename: { record_id: "subject_record_id" },
      add: {
        evidence_uri: {
          schema: fields.text("Where the evidence lives.", "https://x.example"),
          create: "required",
        },
        note: {
          schema: orNull(fields.text("A note.", "Signed copy.")),
          create: "optional",
          update: false,
        },
      },
      serverSet: ["attested_by", "attested_at"],
    })(gateEvidence);
    const doc = docOf(edited);
    const read = schema(doc, "GateEvidence");
    expect(Object.keys(read.properties)).not.toContain("evidence_document_id");
    expect(Object.keys(read.properties)).toContain("subject_record_id");
    expect(Object.keys(read.properties).slice(-2)).toEqual(["evidence_uri", "note"]);
    const create = schema(doc, "GateEvidenceCreate");
    expect(create.required).toContain("evidence_uri");
    expect(create.required).not.toContain("note");
    expect(Object.keys(create.properties)).not.toContain("attested_by");
    expect(Object.keys(schema(doc, "GateEvidenceUpdate").properties)).not.toContain("note");
    expect(gateEvidence.def.read.shape).toHaveProperty("evidence_document_id");
  });

  it("requires or relaxes create fields and drops immutable ones from update", () => {
    const doc = docOf(
      editShape({
        optionalOnCreate: ["currency"],
        requireOnCreate: ["description"],
        immutable: ["currency"],
      })(projects),
    );
    expect(schema(doc, "ProjectCreate").required).toContain("description");
    expect(schema(doc, "ProjectCreate").required).not.toContain("currency");
    expect(Object.keys(schema(doc, "ProjectUpdate").properties)).not.toContain("currency");
  });

  it("refuses an edit that names a field the resource does not have", () => {
    expect(() => editShape({ nullable: ["nope"] })(projects)).toThrow(/not a field/);
    expect(() => removeVerbs("delete")(removeVerbs("delete")(projects))).toThrow(/no delete/);
    expect(() => removeActions("fly")(projects)).toThrow(/no fly action/);
  });

  it("removes verbs and actions, puts actions with capabilities and sets the order", () => {
    const archive = itemAction("archive", {
      summary: "Archive a project",
      description: "Archives the project so it leaves the default lists.",
    });
    const spec = all(
      removeVerbs("delete"),
      removeActions("duplicate"),
      putActions([archive], { archive: "projects.project.archive" }),
      setOrder({ by: ["created_at"], numeric: false, descending: true }),
    )(projects);
    const doc = docOf(spec);
    expect(doc.paths["/projects/{id}"]?.["delete"]).toBeUndefined();
    expect(doc.paths["/projects/{id}/duplicate"]).toBeUndefined();
    expect(doc.paths["/projects/{id}/archive"]?.["post"]?.["x-xos-capability"]).toBe(
      "projects.project.archive",
    );
    const list = doc.paths["/projects"]?.["get"] as Json;
    expect(list["x-xos-order"]).toEqual({ by: ["created_at"], numeric: false, descending: true });
    expect(String(list["description"])).toContain("descending, newest first");
  });
});
