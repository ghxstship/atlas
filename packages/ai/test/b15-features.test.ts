import { describe, expect, it } from "vitest";
import {
  checkOutline,
  draft,
  draftAdvanceAnswers,
  type DraftableSection,
} from "../src/features/drafting.ts";
import {
  extractDocument,
  localDateTimeSupport,
  printedYears,
  RESTRICTED_MISSING,
} from "../src/features/extraction.ts";
import { NeverSendList } from "../src/redact.ts";
import { context, memoryStore, ScriptedModel, toolCall } from "./fakes.ts";

const field = (
  field_path: string,
  value: string | number | null,
  source_excerpt: string | null = null,
) => ({
  field_path,
  value,
  confidence: 0.9,
  source_excerpt,
  missing: value === null ? "Not printed." : null,
});

const textDoc = (data: string) => ({
  type: "document" as const,
  mediaType: "text/plain" as const,
  data,
});

describe("local date and time reading", () => {
  it("accepts a printed date with a printed time only", () => {
    expect(localDateTimeSupport("2027-11-03T08:15", "Depart Nov 3, 2027 8:15 am")).toBe("printed");
    expect(localDateTimeSupport("2027-11-03T20:15", "2027-11-03 20:15")).toBe("printed");
    expect(localDateTimeSupport("2027-11-03T08:15", "Depart Nov 3, 2027")).toBeNull();
    expect(localDateTimeSupport("2027-11-03T08:15", "8:15")).toBeNull();
  });

  it("takes the airline DDMMM form only with a year printed elsewhere in the document", () => {
    expect(
      localDateTimeSupport("2027-11-03T08:15", "GA100 03NOV MIA 08:15", {
        documentYears: new Set(["2027"]),
      }),
    ).toBe("inferred_year");
    expect(
      localDateTimeSupport("2027-11-03T08:15", "GA100 03NOV MIA 08:15", {
        documentYears: new Set(),
      }),
    ).toBeNull();
    expect([...printedYears("Issued 01 Oct 2027. Ticket 03NOV.")]).toEqual(["2027"]);
  });

  it("reads an arrival marked +1 from the departure's date", () => {
    expect(
      localDateTimeSupport("2027-11-04T06:55", "JFK 06:55 +1", {
        departsLocal: "2027-11-03T22:30",
      }),
    ).toBe("next_day");
    expect(
      localDateTimeSupport("2027-11-05T06:55", "JFK 06:55 +1", {
        departsLocal: "2027-11-03T22:30",
      }),
    ).toBeNull();
  });
});

describe("itinerary extraction", () => {
  const segment = (
    passenger: string,
    extra: Partial<Record<string, ReturnType<typeof field>>> = {},
  ) => ({
    fields: [
      field("passenger_name", passenger, `Passenger ${passenger}`),
      field("travel_mode", "Flight"),
      field("operator_name", "Gulf Air Lines"),
      field("service_identifier", "GA 100", "GA 100"),
      field("departs_from", "MIA"),
      field("departs_local", "2027-11-03T22:30", "GA100 03NOV MIA 22:30"),
      field("departs_time_zone", "America/New_York"),
      field("arrives_at_place", "JFK"),
      field("arrives_local", "2027-11-04T06:55", "JFK 06:55 +1"),
      field("arrives_time_zone", "Mars/Olympus"),
      field("price_minor", 45000, "Total fare USD 450.00 for 2 passengers"),
      field("currency_code", "USD"),
      ...Object.values(extra),
    ],
  });

  it("proposes one segment per passenger, reads DDMMM and +1 dates, never splits a shared fare", async () => {
    const model = new ScriptedModel([
      toolCall("record_fields", {
        fields: [],
        lines: [
          segment("Ivy Marchetti"),
          {
            ...segment("Arturo Bell"),
            fields: segment("Arturo Bell").fields.map((f) =>
              f?.field_path === "price_minor"
                ? field("price_minor", 22500, "BELL/ARTURO fare USD 225.00 GA 100")
                : f?.field_path === "travel_mode"
                  ? field("travel_mode", "Plane")
                  : f,
            ),
          },
        ],
      }),
    ]);
    const { store, log } = memoryStore();
    const result = await extractDocument(context(model, store), {
      kind: "itinerary",
      document: textDoc("E-TICKET RECEIPT Issued 01 OCT 2027\nPassport No: X1234567"),
      fileName: "trip.txt",
      subject: { table: "app.ai_intake_batches", id: "b1" },
    });
    expect(log.begun[0]?.subject).toEqual({ table: "app.ai_intake_batches", id: "b1" });
    expect(log.proposed.map((p) => p.change.operationId)).toEqual([
      "auroraIntakes.applyItineraries",
      "auroraIntakes.applyItineraries",
    ]);
    const [ivy, art] = log.proposed.map((p) => p.change.fields);
    const get = (fields: typeof ivy, path: string) => fields?.find((f) => f.field_path === path);
    expect(get(ivy, "departs_local")).toMatchObject({ value: "2027-11-03T22:30" });
    expect(get(ivy, "arrives_local")).toMatchObject({ value: "2027-11-04T06:55" });
    expect(get(ivy, "arrives_time_zone")).toMatchObject({ refusal: "NO_ANSWER" });
    expect(get(ivy, "price_minor")).toMatchObject({ refusal: "NO_ANSWER" });
    expect(get(art, "price_minor")).toMatchObject({ value: 22500 });
    expect(get(art, "travel_mode")).toMatchObject({ refusal: "NO_ANSWER" });
    expect(result).toMatchObject({ kind: "answer", value: { inferred_year: [0, 1] } });
  });

  it("proposes at most 60 segments a document", async () => {
    const model = new ScriptedModel([
      toolCall("record_fields", {
        fields: [],
        lines: Array.from({ length: 61 }, () => segment("Ivy Marchetti")),
      }),
    ]);
    const { store, log } = memoryStore();
    const result = await extractDocument(context(model, store), {
      kind: "itinerary",
      document: textDoc("Issued 01 OCT 2027"),
      fileName: "trip.txt",
      subject: null,
    });
    expect(log.proposed).toHaveLength(60);
    expect(result).toMatchObject({ value: { dropped: 1 } });
  });

  it("withholds passport and birth date values from excerpts and the log", async () => {
    const model = new ScriptedModel([
      toolCall("record_fields", {
        fields: [],
        lines: [
          {
            fields: [
              field(
                "passenger_name",
                "Ivy Marchetti",
                "Passenger Ivy Marchetti Passport No: X1234567 DOB 04/12/1990",
              ),
              field("departs_from", "MIA"),
            ],
          },
        ],
      }),
    ]);
    const { store, log } = memoryStore();
    await extractDocument(context(model, store), {
      kind: "itinerary",
      document: textDoc("x"),
      fileName: "trip.txt",
      subject: null,
    });
    const excerpt = log.proposed[0]?.change.fields.find(
      (f) => f.field_path === "passenger_name",
    )?.source_excerpt;
    expect(excerpt).toBe("Passenger Ivy Marchetti Passport No: [withheld] DOB [withheld]");
    expect(log.completed[0]?.output).not.toContain("X1234567");
    expect(log.completed[0]?.output).not.toContain("04/12/1990");
  });
});

describe("contract extraction", () => {
  const answer = () =>
    toolCall("record_fields", {
      fields: [
        field("act_name", "The Midnight Owls", "Artist: The Midnight Owls"),
        field("contracting_party", "Owl Touring LLC", "f/s/o Owl Touring LLC"),
        field("start_date", "2027-06-04", "Engagement June 4, 2027 for a guarantee of $7,500.00"),
        field("end_date", "2027-06-06", "through June 6, 2027"),
        field("fee_minor", 750000, "Guarantee: $7,500.00"),
        field("currency_code", "USD"),
      ],
    });

  it("reads the fee for a payroll reader and keeps it and every amount out of the log", async () => {
    const model = new ScriptedModel([answer()]);
    const { store, log } = memoryStore();
    await extractDocument(context(model, store), {
      kind: "contract",
      document: textDoc("contract"),
      fileName: "owls.txt",
      subject: { table: "app.ai_intake_batches", id: "b1" },
      readable: ["data.restricted.read.payroll"],
    });
    const fields = log.proposed[0]?.change.fields ?? [];
    expect(log.proposed[0]?.change.operationId).toBe("auroraIntakes.applyContracts");
    expect(fields.find((f) => f.field_path === "fee_minor")).toMatchObject({ value: 750000 });
    expect(fields.find((f) => f.field_path === "start_date")?.source_excerpt).toBe(
      "Engagement June 4, 2027 for a guarantee of [Restricted]",
    );
    expect(model.requests[0]?.system).toContain("fee_minor");
    const output = log.completed[0]?.output ?? "";
    expect(output).toContain("[Restricted]");
    expect(output).not.toContain("750000");
    expect(output).not.toContain("7,500");
    expect(log.proposed[0]?.change.summary).not.toMatch(/7,?500/);
  });

  it("never asks for the fee without payroll and proposes it as NO_ANSWER", async () => {
    const model = new ScriptedModel([answer()]);
    const { store, log } = memoryStore();
    await extractDocument(context(model, store), {
      kind: "contract",
      document: textDoc("contract"),
      fileName: "owls.txt",
      subject: null,
    });
    expect(model.requests[0]?.system).not.toContain("fee_minor");
    expect(log.proposed[0]?.change.fields.find((f) => f.field_path === "fee_minor")).toEqual({
      field_path: "fee_minor",
      refusal: "NO_ANSWER",
      missing: RESTRICTED_MISSING,
    });
    expect(log.completed[0]?.output).not.toContain("750000");
  });
});

describe("invoice and receipt lines", () => {
  it("proposes invoice lines without a budget line or currency, with a tie-out and its flags", async () => {
    const model = new ScriptedModel([
      toolCall("record_fields", {
        fields: [],
        check: [
          field("printed_subtotal_minor", 18000, "Subtotal $180.00"),
          field("printed_tax_minor", 1260, "Tax $12.60"),
          field("printed_total_minor", 19500, "Total $195.00"),
          field("currency_code", "CAD"),
        ],
        lines: [
          {
            fields: [
              field("description", "Wedge monitor rental"),
              field("quantity", 4, "4 x"),
              field("unit_price_minor", 4500, "$45.00"),
            ],
          },
          {
            fields: [
              field("description", "Delivery"),
              field("quantity", null),
              field("unit_price_minor", null),
            ],
          },
        ],
      }),
    ]);
    const { store, log } = memoryStore();
    const result = await extractDocument(context(model, store), {
      kind: "invoice_lines",
      document: textDoc("invoice"),
      fileName: "inv.txt",
      subject: { table: "app.invoices", id: "i1" },
      invoiceCurrency: "USD",
    });
    expect(log.proposed.map((p) => p.change.operationId)).toEqual([
      "invoiceLines.create",
      "invoiceLines.create",
    ]);
    expect(log.proposed[0]?.change.fields.map((f) => f.field_path)).toEqual([
      "description",
      "quantity",
      "unit_price_minor",
    ]);
    expect(result).toMatchObject({
      value: {
        tie_out: {
          linesMinor: 18000,
          subtotalResidualMinor: 0,
          status: "incomplete",
          unpricedLines: [1],
          flags: ["currency_mismatch"],
        },
      },
    });
  });

  it("keeps a receipt's single expense and returns its items and tie-out read-only", async () => {
    const model = new ScriptedModel([
      toolCall("record_fields", {
        fields: [
          field("description", "Crew lunch"),
          field("amount_minor", 6600, "TOTAL 66.00"),
          field("currency_code", "USD"),
        ],
        check: [
          field("printed_tip_minor", 1000, "Tip 10.00"),
          field("printed_total_minor", 6600, "TOTAL 66.00"),
        ],
        check_lines: [
          {
            fields: [
              field("description", "Burger"),
              field("quantity", 2, "2 Burger"),
              field("amount_minor", 3600, "36.00"),
            ],
          },
          {
            fields: [
              field("description", "Soda"),
              field("quantity", 4, "4 Soda"),
              field("amount_minor", 2000, "20.00"),
            ],
          },
        ],
      }),
    ]);
    const { store, log } = memoryStore();
    const result = await extractDocument(context(model, store), {
      kind: "receipt",
      document: textDoc("receipt"),
      fileName: "r.txt",
      subject: null,
    });
    expect(log.proposed.map((p) => p.change.operationId)).toEqual(["expenses.create"]);
    expect(result).toMatchObject({
      value: { tie_out: { linesMinor: 5600, totalResidualMinor: 0, status: "ties" } },
    });
    expect(result.kind === "answer" ? result.value.lines?.length : 0).toBe(2);
  });
});

const sections: DraftableSection[] = [
  {
    id: "s_text",
    title: "Load In Notes",
    prompt: null,
    kind: "Text",
    window_kind: null,
    max_lines: null,
    per_person: false,
    choices: [],
  },
  {
    id: "s_win",
    title: "Load In",
    prompt: null,
    kind: "Schedule Window",
    window_kind: "Load In",
    max_lines: 2,
    per_person: false,
    choices: [],
  },
  {
    id: "s_items",
    title: "Radios",
    prompt: null,
    kind: "Item Request",
    window_kind: null,
    max_lines: 3,
    per_person: false,
    choices: [
      {
        asset_class_id: "cls_radio",
        code: "8000.03.01-XPMS-002",
        name: "Radios",
        offering: "Radios",
      },
    ],
  },
  {
    id: "s_cred",
    title: "Passes",
    prompt: null,
    kind: "Credential Request",
    window_kind: null,
    max_lines: 5,
    per_person: true,
    choices: [{ credential_category_id: "cat_crew", name: "Crew" }],
  },
  {
    id: "s_open",
    title: "Parking",
    prompt: null,
    kind: "Text",
    window_kind: null,
    max_lines: null,
    per_person: false,
    choices: [],
  },
];

describe("advance answers", () => {
  const body =
    "Load in Jun 5, 2027 07:00 to 2027-06-05 09:30. We need 4 radios and two carts. Passes for Kai Moana.";

  it("drafts from a project inbox message sent as a document, never logging its body", async () => {
    const model = new ScriptedModel([
      toolCall("draft_advance_answers", {
        answers: [
          {
            section_id: "s_text",
            body: "Two trucks at 07:00.",
            source_excerpt: "Load in Jun 5, 2027 07:00",
          },
          {
            section_id: "s_win",
            lines: [{ from_local: "2027-06-05T07:00", to_local: "2027-06-05T09:30" }],
            source_excerpt: "Load in Jun 5, 2027 07:00 to 2027-06-05 09:30",
          },
          {
            section_id: "s_items",
            lines: [
              { choice: "Radios", quantity: 4, source_excerpt: "We need 4 radios" },
              { choice: "Carts", quantity: 2, source_excerpt: "two carts" },
              { choice: "Radios", quantity: 6 },
            ],
            source_excerpt: "We need 4 radios",
          },
          {
            section_id: "s_cred",
            lines: [{ choice: "Crew", person_name: "kai moana" }],
            source_excerpt: "Passes for Kai Moana",
          },
          { section_id: "s_text", body: "A second answer." },
        ],
        unanswered: [],
      }),
    ]);
    const { store, log } = memoryStore();
    const result = await draftAdvanceAnswers(context(model, store), {
      recipientId: "rcp",
      sections,
      roster: [
        { id: "e_kai", name: "Kai Moana" },
        { id: "e_mo", name: "Mo Ali" },
      ],
      timeZone: "America/New_York",
      source: { kind: "message", messageId: "m1", body },
      neverSend: new NeverSendList([]),
    });
    expect(log.begun[0]).toMatchObject({
      feature: "drafting",
      subject: { table: "app.advance_recipients", id: "rcp" },
    });
    expect(model.requests[0]?.messages[0]?.content[0]).toEqual({
      type: "document",
      mediaType: "text/plain",
      data: body,
    });
    expect(log.completed[0]?.prompt).toContain("[document text/plain]");
    expect(log.completed[0]?.prompt).not.toContain("Passes for Kai Moana");
    expect(log.proposed.map((p) => [p.change.operationId, p.change.targetId])).toEqual([
      ["aurora.applyAdvanceAnswer", "s_text"],
      ["aurora.applyAdvanceAnswer", "s_win"],
      ["aurora.applyAdvanceAnswer", "s_items"],
      ["aurora.applyAdvanceAnswer", "s_cred"],
    ]);
    expect(log.proposed[1]?.change.fields[0]?.value).toEqual([
      {
        needed_window_start: "2027-06-05T11:00:00.000Z",
        needed_window_end: "2027-06-05T13:30:00.000Z",
        window_zone: "America/New_York",
      },
    ]);
    expect(log.proposed[2]?.change.fields[0]?.value).toEqual([
      { asset_class_id: "cls_radio", quantity: 4 },
    ]);
    expect(log.proposed[3]?.change.fields[0]?.value).toEqual([
      { credential_category_id: "cat_crew", quantity: 1, roster_entry_id: "e_kai" },
    ]);
    if (result.kind !== "answer") throw new Error("expected an answer");
    expect(result.value.answers.find((a) => a.section_id === "s_items")?.dropped).toEqual([
      { line: 2, reason: "choice", choice: "Carts" },
      { line: 3, reason: "quantity" },
    ]);
    expect(result.value.unanswered).toEqual(["s_open"]);
  });

  it("leaves a time the source does not show as NO_ANSWER", async () => {
    const model = new ScriptedModel([
      toolCall("draft_advance_answers", {
        answers: [
          {
            section_id: "s_win",
            lines: [{ from_local: "2027-06-05T08:00", to_local: "2027-06-05T10:00" }],
            source_excerpt: "Load in Jun 5",
          },
        ],
        unanswered: ["s_text"],
      }),
    ]);
    const { store, log } = memoryStore();
    await draftAdvanceAnswers(context(model, store), {
      recipientId: "rcp",
      sections,
      roster: [],
      timeZone: "America/New_York",
      source: { kind: "document", document: textDoc("tour book"), fileName: "tour-book.txt" },
      neverSend: new NeverSendList([]),
    });
    expect(log.proposed[0]?.change.fields[0]).toMatchObject({
      field_path: "lines",
      refusal: "NO_ANSWER",
    });
  });
});

describe("governance drafts", () => {
  it("drafts to the outline and reports missing headings", async () => {
    const model = new ScriptedModel([
      toolCall("draft", {
        title: "Harbor Gala Waste Plan",
        body: "## Waste Streams\nCompost and recycling.\n## Diversion Targets\n[needs: diversion target]",
        gaps: [],
      }),
    ]);
    const { store, log } = memoryStore();
    const headings = ["Waste Streams", "Bins and Placement", "Diversion Targets"];
    const result = await draft(context(model, store), {
      kind: "waste_plan",
      instructions: "Draft the waste plan.",
      context: [],
      verbiage: [],
      neverSend: new NeverSendList([]),
      subject: null,
      outline: headings,
    });
    expect(log.begun[0]?.subject).toBeUndefined();
    expect(model.requests[0]?.system).toContain(
      "Waste Streams; Bins and Placement; Diversion Targets",
    );
    expect(result).toMatchObject({
      value: { missingHeadings: ["Bins and Placement"], gaps: ["diversion target"] },
    });
    expect(checkOutline("# Overview\n## Schedule", ["Overview", "Schedule", "Contacts"])).toEqual([
      "Contacts",
    ]);
  });
});
