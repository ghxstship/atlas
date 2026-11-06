/**
 * Contract tests for R9's typed advance sections (RRR-189, migrations 2710 to 2716): section choices, the lines and
 * files of typed answers, `advanceSections.configure`, and the recipient's `bindEngagement` and `setNamesDue` (G-141).
 * Requests run through `contractApp` against the in-memory client; every success is checked against openapi/v1.json
 * with `expectContract`. A configuration that does not fit its kind answers 400; a database refusal 422 with its rule.
 */
import { describe, expect, it } from "vitest";
import { handlers as advancing } from "../src/handlers/advancing.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(29100 + n).padStart(12, "0")}`;
const PACKET = id(1);
const SECTION = id(2);
const RECIPIENT = id(3);
const COUNTERPARTY = id(4);
const ENGAGEMENT = id(5);
const CHOICE = id(6);
const CLASS = id(7);
const ANSWER = id(8);
const LINE = id(9);
const FILE = id(10);
const DOCUMENT = id(11);
const CATEGORY = id(12);

function world() {
  const db: MemoryDb = memoryDb(
    {
      advance_packets: [
        tenantRow(PACKET, ORG, {
          project_id: id(20),
          title: "Vendor Advance",
          due_at: null,
          sent_at: null,
        }),
      ],
      advance_sections: [
        tenantRow(SECTION, ORG, {
          advance_packet_id: PACKET,
          position: 1,
          title: "Radios and carts",
          prompt: null,
          section_kind: "Item Request",
          window_kind: null,
          max_lines: 5,
          per_person: false,
        }),
      ],
      advance_recipients: [
        tenantRow(RECIPIENT, ORG, {
          advance_packet_id: PACKET,
          person_id: null,
          counterparty_id: COUNTERPARTY,
          engagement_id: null,
          names_due_at: null,
        }),
      ],
      advance_section_choices: [
        tenantRow(CHOICE, ORG, {
          advance_section_id: SECTION,
          asset_class_id: CLASS,
          credential_category_id: null,
        }),
      ],
      advance_submission_lines: [
        tenantRow(LINE, ORG, {
          advance_submission_id: ANSWER,
          line_number: 1,
          asset_class_id: CLASS,
          credential_category_id: null,
          roster_entry_id: null,
          quantity: 6,
          needed_window: '["2027-06-01 08:00:00+00","2027-06-01 10:00:00+00")',
          window_zone: "America/New_York",
          note: null,
        }),
      ],
      advance_submission_files: [
        tenantRow(FILE, ORG, { advance_submission_id: ANSWER, document_id: DOCUMENT, position: 1 }),
      ],
    },
    {},
    {
      advance_section_choices: { asset_class_id: null, credential_category_id: null },
      advance_sections: {
        prompt: null,
        section_kind: "Text",
        window_kind: null,
        max_lines: null,
        per_person: false,
      },
    },
  );
  const app = contractApp({ handlers: [advancing], db });
  return { db, http: requests(app) };
}

describe("R9 contract: section choices", () => {
  it("lists, reads, creates and removes choices", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/advance-section-choices")),
      "advanceSectionChoices.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["asset_class_id"]).toBe(CLASS);
    await expectContract(
      await success(http.get(`/advance-section-choices/${CHOICE}`)),
      "advanceSectionChoices.get",
    );
    const post = await success(
      http.post("/advance-section-choices", {
        advance_section_id: SECTION,
        credential_category_id: CATEGORY,
      }),
    );
    const made = (await expectContract(post, "advanceSectionChoices.create")) as Row;
    expect(made["credential_category_id"]).toBe(CATEGORY);
    await expectContract(
      await success(http.delete(`/advance-section-choices/${CHOICE}`)),
      "advanceSectionChoices.delete",
    );
    expect((await http.get(`/advance-section-choices/${CHOICE}`)).status).toBe(404);
  });
});

describe("R9 contract: typed answer lines and files", () => {
  it("reads lines and files", async () => {
    const { http } = world();
    const lines = (await expectContract(
      await success(http.get("/advance-submission-lines")),
      "advanceSubmissionLines.list",
    )) as { data: Row[] };
    expect(lines.data[0]?.["quantity"]).toBe(6);
    await expectContract(
      await success(http.get(`/advance-submission-lines/${LINE}`)),
      "advanceSubmissionLines.get",
    );
    await expectContract(
      await success(http.get("/advance-submission-files")),
      "advanceSubmissionFiles.list",
    );
    const file = (await expectContract(
      await success(http.get(`/advance-submission-files/${FILE}`)),
      "advanceSubmissionFiles.get",
    )) as Row;
    expect(file["document_id"]).toBe(DOCUMENT);
    expect(
      (await http.post("/advance-submission-lines", { advance_submission_id: ANSWER })).status,
    ).toBe(404);
  });
});

describe("R9 contract: configuring sections and recipients", () => {
  it("configures a section's kind", async () => {
    const { http, db } = world();
    const res = await success(
      http.post(`/advance-sections/${SECTION}/configure`, {
        section_kind: "Schedule Window",
        window_kind: "Load In",
        max_lines: 2,
      }),
    );
    const section = (await expectContract(res, "advanceSections.configure")) as Row;
    expect(section["section_kind"]).toBe("Schedule Window");
    expect(section["window_kind"]).toBe("Load In");
    expect(db.tables["advance_sections"]?.[0]?.["max_lines"]).toBe(2);
    const misfit = await http.post(`/advance-sections/${SECTION}/configure`, {
      section_kind: "Schedule Window",
      max_lines: 2,
    });
    expect(misfit.status).toBe(400);
    expect(
      (await http.post(`/advance-sections/${id(99)}/configure`, { section_kind: "Text" })).status,
    ).toBe(404);
  });

  it("links a recipient to its engagement and sets its naming deadline", async () => {
    const { http, db } = world();
    const bind = await success(
      http.post(`/advance-recipients/${RECIPIENT}/bind-engagement`, { engagement_id: ENGAGEMENT }),
    );
    const bound = (await expectContract(bind, "advanceRecipients.bindEngagement")) as Row;
    expect(bound["engagement_id"]).toBe(ENGAGEMENT);
    const set = await success(
      http.post(`/advance-recipients/${RECIPIENT}/set-names-due`, {
        names_due_at: "2027-05-20T23:59:00Z",
      }),
    );
    const due = (await expectContract(set, "advanceRecipients.setNamesDue")) as Row;
    expect(due["names_due_at"]).toBe("2027-05-20T23:59:00Z");
    db.fail("advance_recipients", {
      code: "23514",
      message:
        'new row for relation "advance_recipients" violates check constraint "advance_recipients_names_due_engagement"',
    });
    expect(
      (await http.post(`/advance-recipients/${RECIPIENT}/set-names-due`, { names_due_at: null }))
        .status,
    ).not.toBe(200);
  });
});
