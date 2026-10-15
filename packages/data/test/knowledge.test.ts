import { describe, expect, it } from "vitest";
import {
  EM_DASH,
  acknowledgeSop,
  addDocumentVersion,
  createDocument,
  createSop,
  createVerbiageTerm,
  deleteDocument,
  deleteSop,
  deleteVerbiageTerm,
  getDocument,
  getSop,
  hasUnpublishedChanges,
  lastChange,
  listDocuments,
  listSopAcknowledgments,
  listSops,
  listStandardSops,
  listStandardVerbiage,
  listVerbiageTerms,
  nextSopCode,
  publishSop,
  renameDocument,
  sopStanding,
  updateSop,
  updateVerbiageTerm,
  verbiageProblems,
} from "../src/knowledge.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

const SHA = "a".repeat(64);

describe("sops", () => {
  const sopRow = {
    id: "s1",
    code: "SOP-002",
    title: "Load in",
    body: "Steps.",
    version: 2,
    published_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    sop_acknowledgments: [
      { person_id: "p1", sop_version: 2 },
      { person_id: "p2", sop_version: 1 },
    ],
  };

  it("lists SOPs with the person's acknowledgment of the current version", async () => {
    const { db, calls } = commercialClient({
      "from:sops": [
        okResponse([
          sopRow,
          { ...sopRow, id: "s2", published_at: null, sop_acknowledgments: null },
        ]),
        okResponse(sopRow),
        okResponse(null),
      ],
    });
    const list = await listSops(db, "o1", "p1");
    expect(list.ok && list.data.map((s) => [s.acknowledgedByMe, s.currentAcknowledgments])).toEqual(
      [
        [true, 1],
        [false, 0],
      ],
    );
    expect(calls[0]?.steps).toContainEqual(["order", ["code"]]);
    const one = await getSop(db, "s1", null);
    expect(one.ok && one.data.acknowledgedByMe).toBe(false);
    expect((await getSop(db, "s9", "p1")).ok).toBe(false);
  });

  it("derives standing, pending edits and the next code", () => {
    expect(sopStanding({ publishedAt: null })).toBe("draft");
    expect(sopStanding({ publishedAt: "t" })).toBe("published");
    expect(
      hasUnpublishedChanges({
        publishedAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
      }),
    ).toBe(true);
    expect(
      hasUnpublishedChanges({
        publishedAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00.500Z",
      }),
    ).toBe(false);
    expect(hasUnpublishedChanges({ publishedAt: null, updatedAt: "t" })).toBe(false);
    expect(nextSopCode(["SOP-001", "SOP-014", "OTHER"])).toBe("SOP-015");
    expect(nextSopCode([])).toBe("SOP-001");
  });

  it("creates, publishes, acknowledges and deletes", async () => {
    const now = new Date("2026-10-14T00:00:00Z");
    const { db, calls } = commercialClient({
      "from:sops": [
        okResponse({ id: "s1" }),
        okResponse([{ id: "s1" }]),
        okResponse([{ id: "s1" }]),
      ],
      "from:sop_acknowledgments": [
        okResponse({ id: "a1" }),
        errorResponse(
          "XR001",
          "sop_unpublished: Only a published SOP is acknowledged.",
          "sop_unpublished",
        ),
      ],
    });
    expect(
      (await createSop(db, "o1", { code: " sop-003 ", title: " Rigging ", body: "Body" })).ok,
    ).toBe(true);
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { org_id: "o1", code: "SOP-003", title: "Rigging", body: "Body" },
    ]);
    expect((await publishSop(db, "s1", now)).ok).toBe(true);
    expect(calls[1]?.steps[0]).toEqual(["update", [{ published_at: "2026-10-14T00:00:00.000Z" }]]);
    expect((await acknowledgeSop(db, "s1", "p1")).ok).toBe(true);
    const refused = await acknowledgeSop(db, "s2", "p1");
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "sop_unpublished",
    );
    expect((await deleteSop(db, "s1")).ok).toBe(true);
  });

  it("saves edits only over the version the editor loaded", async () => {
    const { db, calls } = commercialClient({
      "from:sops": [
        okResponse([{ id: "s1" }]),
        okResponse([]),
        okResponse({ id: "s1" }),
        okResponse([]),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    const input = { title: "T", body: "B", expectedUpdatedAt: "2026-10-01T00:00:00Z" };
    expect(await updateSop(db, "s1", input)).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps).toContainEqual(["eq", ["updated_at", "2026-10-01T00:00:00Z"]]);
    expect(await updateSop(db, "s1", input)).toEqual({
      ok: false,
      error: { kind: "conflict", message: "sop_edited_elsewhere" },
    });
    expect(await updateSop(db, "s9", input)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await updateSop(db, "s1", input)).ok).toBe(false);
  });

  it("lists acknowledgments and Standard Library SOPs", async () => {
    const { db } = commercialClient({
      "from:sop_acknowledgments": [
        okResponse([
          { person_id: "p1", sop_version: 2, acknowledged_at: "t", person: { full_name: "Dave" } },
          { person_id: "p2", sop_version: 1, acknowledged_at: "t", person: null },
        ]),
      ],
      "from:xpms:std_sop": [
        okResponse([
          {
            sop_id: "SOP-STD-1",
            title: null,
            prerequisites_and_hazards: "Hard hat.",
            procedure_step_1: "Step one.",
            procedure_step_2: null,
            procedure_step_3: null,
            procedure_step_4: "Step four.",
          },
        ]),
      ],
    });
    const acks = await listSopAcknowledgments(db, "s1");
    expect(acks.ok && acks.data.map((a) => a.personName)).toEqual(["Dave", null]);
    const std = await listStandardSops(db);
    expect(std.ok && std.data[0]).toEqual({
      id: "SOP-STD-1",
      title: "SOP-STD-1",
      body: "Hard hat.\n\nStep one.\n\nStep four.",
    });
  });
});

describe("documents", () => {
  const version = (n: number, at: string) => ({
    id: `v${n}`,
    version_number: n,
    storage_uri: `https://files.example.com/${n}`,
    checksum_sha256: SHA,
    created_at: at,
    created_by: "p1",
    author: n === 1 ? null : { full_name: "Ada" },
  });

  it("lists documents newest change first with versions in descending order", async () => {
    const { db } = commercialClient({
      "from:documents": [
        okResponse([
          {
            id: "d1",
            title: "Site plan",
            project_id: null,
            updated_at: "2026-10-01T00:00:00Z",
            project: null,
            document_versions: [
              version(1, "2026-10-01T00:00:00Z"),
              version(2, "2026-10-05T00:00:00Z"),
            ],
          },
          {
            id: "d2",
            title: "Rider",
            project_id: "p1",
            updated_at: "2026-10-03T00:00:00Z",
            project: { project_key: "NWL" },
            document_versions: null,
          },
        ]),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    const list = await listDocuments(db, "o1");
    expect(list.ok && list.data.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(list.ok && list.data[0]?.latestVersion?.versionNumber).toBe(2);
    expect(list.ok && list.data[0]?.latestVersion?.createdByName).toBe("Ada");
    expect(list.ok && list.data[1]?.projectKey).toBe("NWL");
    expect((await getDocument(db, "d9")).ok).toBe(false);
    expect((await listDocuments(db, "o1")).ok).toBe(false);
  });

  it("knows when a document last changed", () => {
    expect(lastChange({ updatedAt: "2026-10-01", latestVersion: null })).toBe("2026-10-01");
    expect(
      lastChange({ updatedAt: "2026-10-01", latestVersion: { createdAt: "2026-10-09" } as never }),
    ).toBe("2026-10-09");
  });

  it("creates a document with its first version and appends versions", async () => {
    const { db, calls } = commercialClient({
      "from:documents": [
        okResponse({ id: "d1" }),
        errorResponse("42501", "no"),
        okResponse([{ id: "d1" }]),
        okResponse([{ id: "d1" }]),
        okResponse({ id: "d2" }),
      ],
      "from:document_versions": [
        okResponse({ id: "v1" }),
        okResponse({ id: "v2" }),
        errorResponse("42501", "no"),
      ],
    });
    const input = {
      title: " Plan ",
      projectId: "",
      storageUri: " https://files.example.com/plan.pdf ",
      checksumSha256: SHA,
    };
    expect(await createDocument(db, "o1", input)).toEqual({ ok: true, data: { id: "d1" } });
    expect(calls[0]?.steps[0]?.[1]).toEqual([{ org_id: "o1", title: "Plan", project_id: null }]);
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        document_id: "d1",
        storage_uri: "https://files.example.com/plan.pdf",
        checksum_sha256: SHA,
      },
    ]);
    expect((await createDocument(db, "o1", input)).ok).toBe(false);
    expect(await createDocument(db, "o1", { ...input, checksumSha256: "XYZ" })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "checksum" },
    });
    expect((await renameDocument(db, "d1", " New ")).ok).toBe(true);
    expect((await addDocumentVersion(db, "d1", { storageUri: "u", checksumSha256: SHA })).ok).toBe(
      true,
    );
    expect(await addDocumentVersion(db, "d1", { storageUri: "u", checksumSha256: "bad" })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "checksum" },
    });
    expect((await deleteDocument(db, "d1")).ok).toBe(true);
    expect((await createDocument(db, "o1", input)).ok).toBe(false);
  });
});

describe("verbiage", () => {
  it("checks invariant 24 before the round trip", () => {
    expect(
      verbiageProblems({
        term: "Load In",
        casingRule: "Title Case",
        definition: "The arrival of gear.",
      }),
    ).toEqual([]);
    expect(
      verbiageProblems({ term: ` A${EM_DASH}B`, casingRule: "x", definition: "No period" }),
    ).toEqual(["em_dash", "definition_sentence"]);
    expect(verbiageProblems({ term: " ", casingRule: "x", definition: "Ok." })).toEqual([
      "term_length",
    ]);
  });

  it("lists terms alphabetically and edits them", async () => {
    const { db, calls } = commercialClient({
      "from:verbiage_terms": [
        okResponse([
          { id: "t2", term: "Strike", casing_rule: "Title Case", definition: "Teardown." },
          { id: "t1", term: "Advance", casing_rule: "Title Case", definition: "Prep." },
        ]),
        errorResponse("08006", "down"),
        okResponse({ id: "t3" }),
        okResponse([{ id: "t3" }]),
        okResponse([{ id: "t3" }]),
      ],
      "from:xpms:std_verbiage": [
        okResponse([
          { record_id: "VB-1", verbiage: null, title: "Cue", description: null },
          { record_id: "VB-2", verbiage: null, title: null, description: "D." },
        ]),
      ],
    });
    const list = await listVerbiageTerms(db, "o1");
    expect(list.ok && list.data.map((t) => t.term)).toEqual(["Advance", "Strike"]);
    expect((await listVerbiageTerms(db, "o1")).ok).toBe(false);
    const input = { term: " Cue ", casingRule: " Title Case ", definition: " A signal. " };
    expect((await createVerbiageTerm(db, "o1", input)).ok).toBe(true);
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      { term: "Cue", casing_rule: "Title Case", definition: "A signal.", org_id: "o1" },
    ]);
    expect((await updateVerbiageTerm(db, "t3", input)).ok).toBe(true);
    expect((await deleteVerbiageTerm(db, "t3")).ok).toBe(true);
    const std = await listStandardVerbiage(db);
    expect(std.ok && std.data.map((s) => s.term)).toEqual(["Cue", "VB-2"]);
  });
});
