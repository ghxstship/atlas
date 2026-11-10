import { describe, expect, it } from "vitest";
import {
  containsMoney,
  draft,
  draftAdvanceAnswers,
  extractDocument,
  NeverSendList,
  readLocalDateTime,
  type DraftableSection,
  type ProposedField,
} from "../src/index.ts";
import { tieOut } from "../src/intake.ts";
import { context, memoryStore, ScriptedModel, toolCall } from "./fakes.ts";

const document = (data: string) => ({
  type: "document" as const,
  mediaType: "text/plain" as const,
  data,
});
const field = (fields: readonly ProposedField[], path: string) =>
  fields.find((f) => f.field_path === path);
const cutOff = (name: string, input: unknown) => ({
  ...toolCall(name, input),
  stopReason: "max_tokens" as const,
});

const segment = (over: Record<string, unknown> = {}) => ({
  passengers: [{ name: "Ivy Marchetti" }],
  travel_mode: "flight",
  operator_name: "Gulf Air",
  service_identifier: "GA 100",
  confirmation_identifier: "ABC123",
  departs_from: "MIA",
  arrives_at_place: "ORD",
  departs_local: "2027-03-12T08:15",
  arrives_local: "2027-03-12T10:30",
  departs_time_zone: "America/New_York",
  arrives_time_zone: "America/Chicago",
  source_excerpt: "GA 100 Mar 12 2027 08:15 MIA to ORD Mar 12 2027 10:30",
  confidence: 0.9,
  missing: [],
  ...over,
});

const itinerary = async (segments: readonly unknown[], projectToday = "2027-01-04") => {
  const { store, log } = memoryStore();
  const model = new ScriptedModel([toolCall("record_fields", { segments })]);
  const result = await extractDocument(context(model, store), {
    kind: "itinerary",
    document: document("confirmation"),
    fileName: "trip.txt",
    subject: { table: "app.projects", id: "p1" },
    projectToday,
  });
  return { result, log, model, proposals: log.proposed.map((p) => p.change) };
};

describe("itinerary extraction", () => {
  it("expands passengers: two passengers on two legs are four lines, and nothing is written", async () => {
    const { result, proposals, log } = await itinerary([
      segment({ passengers: [{ name: "Ivy Marchetti" }, { name: "Arturo Bell" }] }),
      segment({
        passengers: [{ name: "Ivy Marchetti" }, { name: "Arturo Bell" }],
        service_identifier: "GA 101",
      }),
    ]);
    expect(result.kind).toBe("answer");
    expect(proposals).toHaveLength(4);
    expect(proposals.every((p) => p.operationId === "travelSegments.create")).toBe(true);
    expect(proposals.flatMap((p) => p.fields).some((f) => f.field_path === "person_id")).toBe(
      false,
    );
    expect(log.begun[0]?.subject).toEqual({ table: "app.projects", id: "p1" });
  });

  it("makes a date or time the excerpt does not show NO_ANSWER", async () => {
    const { proposals } = await itinerary([segment({ source_excerpt: "GA 100 MIA to ORD" })]);
    expect(field(proposals[0]?.fields ?? [], "departs_local")?.refusal).toBe("NO_ANSWER");
    expect(field(proposals[0]?.fields ?? [], "departs_at")?.refusal).toBe("NO_ANSWER");
  });

  it("makes a whole-booking price NO_ANSWER, and keeps a passenger's own", async () => {
    const { proposals } = await itinerary([
      segment({
        passengers: [
          {
            name: "Ivy Marchetti",
            price_minor: 90000,
            currency_code: "USD",
            price_excerpt: "Total paid USD 900.00",
          },
          {
            name: "Arturo Bell",
            price_minor: 45000,
            currency_code: "USD",
            price_excerpt: "BELL/ARTURO fare USD 450.00",
          },
        ],
      }),
    ]);
    expect(field(proposals[0]?.fields ?? [], "price_minor")?.refusal).toBe("NO_ANSWER");
    expect(field(proposals[1]?.fields ?? [], "price_minor")?.value).toBe(45000);
    expect(field(proposals[1]?.fields ?? [], "currency_code")?.value).toBe("USD");
  });

  it("infers a missing year from the project's today, as its own boolean field", async () => {
    const { proposals } = await itinerary([
      segment({
        departs_local: "2020-03-12T08:15",
        arrives_local: "2020-03-12T10:30",
        source_excerpt: "GA 100 Mar 12 08:15 MIA to ORD Mar 12 10:30",
      }),
    ]);
    const fields = proposals[0]?.fields ?? [];
    expect(field(fields, "departs_local")?.value).toBe("2027-03-12T08:15");
    expect(field(fields, "year_inferred")).toMatchObject({ value: true, confidence: 1 });
  });

  it("reads a Dec 31 to Jan 1 flight read on Jan 2 as one night, not a year apart", async () => {
    const { proposals } = await itinerary(
      [
        segment({
          departs_local: "2026-12-31T23:30",
          arrives_local: "2027-01-01T01:10",
          source_excerpt: "GA 7 Dec 31 23:30 MIA to ORD Jan 1 01:10",
        }),
      ],
      "2027-01-02",
    );
    const fields = proposals[0]?.fields ?? [];
    expect(field(fields, "departs_local")?.value).toBe("2027-12-31T23:30");
    expect(field(fields, "arrives_local")?.value).toBe("2028-01-01T01:10");
  });

  it("drops an invalid zone with its reason, +05:00 and EST among them", async () => {
    for (const zone of ["+05:00", "EST", "Mars/Olympus"]) {
      const { result, proposals } = await itinerary([
        segment({ departs_time_zone: zone }),
        segment({ service_identifier: "GA 2" }),
      ]);
      expect(proposals).toHaveLength(1);
      expect(result.kind === "answer" && result.value.dropped).toEqual([
        { line: 1, reason: "zone" },
      ]);
    }
  });

  it("clamps a zone's confidence to one half in code", async () => {
    const { proposals } = await itinerary([segment({ confidence: 0.99 })]);
    expect(field(proposals[0]?.fields ?? [], "departs_time_zone")?.confidence).toBe(0.5);
    expect(field(proposals[0]?.fields ?? [], "departs_from")?.confidence).toBe(0.99);
  });

  it("drops an arrival before its departure", async () => {
    const { result, proposals } = await itinerary([
      segment({
        arrives_local: "2027-03-12T05:00",
        source_excerpt: "GA 100 Mar 12 2027 08:15 MIA to ORD Mar 12 2027 05:00",
      }),
      segment({ service_identifier: "GA 2" }),
    ]);
    expect(proposals).toHaveLength(1);
    expect(result.kind === "answer" && result.value.dropped).toEqual([{ line: 1, reason: "time" }]);
  });

  it("drops a line past a column's length, never repairing it", async () => {
    const { result, proposals } = await itinerary([
      segment({ service_identifier: "X".repeat(41) }),
      segment({ service_identifier: "GA 2" }),
    ]);
    expect(proposals).toHaveLength(1);
    expect(result.kind === "answer" && result.value.dropped).toEqual([
      { line: 1, reason: "length" },
    ]);
  });

  it("computes instants in each place's own zone, across a change of the clocks", async () => {
    const { proposals } = await itinerary([
      segment({
        departs_local: "2027-03-14T01:30",
        arrives_local: "2027-03-14T03:30",
        arrives_time_zone: "America/New_York",
        source_excerpt: "GA 9 Mar 14 2027 01:30 MIA to JFK Mar 14 2027 03:30",
      }),
    ]);
    const fields = proposals[0]?.fields ?? [];
    expect(field(fields, "departs_at")?.value).toBe("2027-03-14T06:30:00.000Z");
    expect(field(fields, "arrives_at")?.value).toBe("2027-03-14T07:30:00.000Z");
  });

  it("caps a document at 40 lines after expansion and reports the rest", async () => {
    const passengers = Array.from({ length: 7 }, (_, i) => ({ name: `Person ${i}` }));
    const { result, proposals } = await itinerary(
      Array.from({ length: 6 }, (_, i) => segment({ passengers, service_identifier: `GA ${i}` })),
    );
    expect(proposals).toHaveLength(40);
    expect(result.kind === "answer" && result.value.too_many).toBe(2);
  });
});

describe("a tool call cut off at the token limit stores nothing", () => {
  const kinds = [
    ["itinerary", { segments: [segment()] }],
    ["invoice", { fields: [], read: [], lines: [] }],
    ["receipt", { fields: [], read: [], lines: [] }],
    ["rider", { fields: [], lines: [] }],
    ["quote", { fields: [], lines: [] }],
    ["insurance_certificate", { fields: [], lines: [] }],
    ["contract", { fields: [], lines: [] }],
  ] as const;
  it.each(kinds)("%s", async (kind, input) => {
    const { store, log } = memoryStore();
    const model = new ScriptedModel([cutOff("record_fields", input)]);
    const result = await extractDocument(context(model, store), {
      kind,
      document: document("a long document"),
      fileName: "long.txt",
      subject: null,
    });
    expect(result).toMatchObject({ kind: "failed", code: "model_output_invalid" });
    expect(log.proposed).toHaveLength(0);
  });
});

describe("readLocalDateTime", () => {
  it("needs the month, day and time word for word", () => {
    expect(readLocalDateTime("2027-03-12T08:15", "Mar 12 2027 at 8:15 am", "2027-01-01")).toEqual({
      value: "2027-03-12T08:15",
      yearInferred: false,
    });
    expect(readLocalDateTime("2027-03-12T08:15", "12MAR 0815", "2027-01-01")).toEqual({
      value: "2027-03-12T08:15",
      yearInferred: true,
    });
    expect(readLocalDateTime("2027-03-12T08:15", "Mar 13 08:15", "2027-01-01")).toBeNull();
    expect(readLocalDateTime("2027-03-12T08:15", "Mar 12", "2027-01-01")).toBeNull();
  });

  it("counts an arrival printed +1 from its departure", () => {
    expect(
      readLocalDateTime("2027-03-13T01:10", "arrives 01:10 +1", "2027-03-12", "2027-03-12T23:30"),
    ).toEqual({ value: "2027-03-13T01:10", yearInferred: false });
  });
});

const rawField = (
  path: string,
  value: unknown,
  excerpt: string | null = null,
  missing: string | null = null,
) => ({
  field_path: path,
  value,
  confidence: value === null ? null : 0.9,
  source_excerpt: excerpt,
  missing,
});

const contract = async (fields: readonly unknown[], feeVisible: boolean) => {
  const { store, log } = memoryStore();
  const model = new ScriptedModel([toolCall("record_fields", { fields, lines: [] })]);
  const result = await extractDocument(context(model, store), {
    kind: "contract",
    document: document("agreement"),
    fileName: "agreement.txt",
    subject: { table: "app.projects", id: "p1" },
    feeVisible,
  });
  return { result, log, model, fields: log.proposed[0]?.change.fields ?? [] };
};

describe("contract extraction", () => {
  const FEE = [
    rawField("document_type", "Contract", "ARTIST BOOKING AGREEMENT"),
    rawField("title", "Booking Agreement", "ARTIST BOOKING AGREEMENT"),
    rawField("act_name", "The Midnight Owls", "Artist: The Midnight Owls"),
    rawField("start_date", "2027-06-05", "Performance date: June 5, 2027"),
    rawField("agreed_rate_minor", 750000, "Guarantee: USD 7,500.00"),
    rawField("agreed_rate_currency_code", "USD", "Guarantee: USD 7,500.00"),
  ];

  it("asks for a fee only of someone who reads pay, in the schema and the prompt", async () => {
    const hidden = await contract(FEE, false);
    const request = hidden.model.requests[0];
    expect(JSON.stringify(request?.tools)).not.toContain("agreed_rate");
    expect(request?.system).not.toContain("agreed_rate");
    expect(hidden.fields.some((f) => f.field_path.startsWith("agreed_rate"))).toBe(false);
    const shown = await contract(FEE, true);
    expect(shown.model.requests[0]?.system).toContain("agreed_rate_minor");
    expect(field(shown.fields, "agreed_rate_minor")).toMatchObject({
      value: 750000,
      source_excerpt: "Guarantee: USD 7,500.00",
    });
    expect(field(shown.fields, "agreed_rate_currency_code")?.value).toBe("USD");
  });

  it("logs a fixed sentence with counts and no model text", async () => {
    const { log } = await contract(FEE, true);
    expect(log.completed[0]?.output).toBe("Read 6 of 7 fields from one document.");
    expect(log.completed[0]?.output).not.toMatch(/7,500|Owls/);
  });

  it.each([["the currency excerpt", rawField("agreed_rate_currency_code", "USD", "USD 50,000")]])(
    "keeps %s behind the fee's path",
    async (_name, raw) => {
      const hidden = await contract(
        [rawField("document_type", "Contract", "AGREEMENT"), raw],
        false,
      );
      expect(JSON.stringify(hidden.fields)).not.toContain("50,000");
    },
  );

  it("turns a money amount in any other field into NO_ANSWER with no excerpt", async () => {
    const { fields } = await contract(
      [
        rawField("document_type", "Contract", "AGREEMENT"),
        rawField("start_date", "2027-06-05", "Guarantee: 50,000.00 payable June 5, 2027"),
        rawField("end_date", "2027-06-06", "fee of fifty thousand dollars by June 6, 2027"),
        rawField("title", "Agreement for USD 50,000", "Agreement"),
        rawField("act_name", "The Midnight Owls", "$7,500 to The Midnight Owls"),
      ],
      false,
    );
    for (const path of ["start_date", "end_date", "title", "act_name"]) {
      const f = field(fields, path);
      expect(f?.refusal, path).toBe("NO_ANSWER");
      expect(f?.source_excerpt, path).toBeUndefined();
    }
    expect(JSON.stringify(fields)).not.toMatch(/50,000|fifty|7,500/);
  });

  it("stores fixed sentences, never the model's missing text", async () => {
    const { fields } = await contract(
      [
        rawField("document_type", "Contract", "AGREEMENT"),
        rawField("start_date", null, null, "The fee of USD 50,000 has no date."),
      ],
      false,
    );
    expect(field(fields, "start_date")?.missing).not.toContain("50,000");
    expect(field(fields, "title")?.missing).toBe(field(fields, "start_date")?.missing);
  });

  it("reads a date in an excerpt with no money as a date", async () => {
    expect(containsMoney("Performance date: June 5, 2027")).toBe(false);
    expect(containsMoney("Performance date: 05.06.2027")).toBe(false);
    expect(containsMoney("2027-06-05")).toBe(false);
    expect(containsMoney("Guarantee 50000 on 2027-06-05")).toBe(true);
    expect(containsMoney("USD 50,000")).toBe(true);
    expect(containsMoney("50.000,00 EUR")).toBe(true);
  });
});

const amounts = async (kind: "invoice" | "receipt", input: unknown) => {
  const { store, log } = memoryStore();
  const model = new ScriptedModel([toolCall("record_fields", input)]);
  const result = await extractDocument(context(model, store), {
    kind,
    document: document("bill"),
    fileName: "bill.txt",
    subject: null,
  });
  return { result, proposals: log.proposed.map((p) => p.change) };
};

const invoiceInput = {
  fields: [
    rawField("invoice_number", "4471", "INVOICE 4471"),
    rawField("currency_code", "USD", "USD"),
    rawField("printed_total_minor", 108000, "Total 1,080.00"),
  ],
  read: [
    rawField("vendor_name", "Bayside Audio", "Bayside Audio"),
    rawField("printed_subtotal_minor", 100000, "Subtotal 1,000.00"),
    rawField("printed_tax_minor", 8000, "Tax 80.00"),
  ],
  lines: [
    {
      description: "Wedge monitor rental",
      quantity: 2,
      price_minor: 45000,
      source_excerpt: "2 x Wedge monitor rental @ 450.00",
      confidence: 0.9,
      missing: [],
    },
    {
      description: "Delivery",
      quantity: 1,
      price_minor: 10000,
      source_excerpt: "1 x Delivery @ 100.00",
      confidence: 0.9,
      missing: [],
    },
  ],
};

describe("invoice and receipt lines", () => {
  it("proposes the header, each line and the printed tax as a line; shown values stay out", async () => {
    const { result, proposals } = await amounts("invoice", invoiceInput);
    expect(proposals.map((p) => p.operationId)).toEqual([
      "invoices.create",
      "invoiceLines.create",
      "invoiceLines.create",
      "invoiceLines.create",
    ]);
    expect(field(proposals[0]?.fields ?? [], "printed_total_minor")?.value).toBe(108000);
    expect(field(proposals[0]?.fields ?? [], "vendor_name")).toBeUndefined();
    expect(field(proposals[0]?.fields ?? [], "printed_tax_minor")).toBeUndefined();
    expect(result.kind === "answer" && result.value.read?.["vendor_name"]?.value).toBe(
      "Bayside Audio",
    );
    const tax = proposals[3]?.fields ?? [];
    expect(field(tax, "description")?.value).toBe("Tax");
    expect(field(tax, "unit_price_minor")).toMatchObject({
      value: 8000,
      source_excerpt: "Tax 80.00",
    });
  });

  it("ties with the tax row kept, and equals the SQL with it unchecked", async () => {
    const { result, proposals } = await amounts("invoice", invoiceInput);
    expect(result.kind === "answer" && result.value.tie_out).toMatchObject({
      status: "ties",
      residualMinor: 0,
    });
    // The panel leaves printed tax out of the tie-out, so unchecking the row shows what app.invoice_tie_out will.
    const lines = proposals.slice(1).map((p) => ({
      quantity: field(p.fields, "quantity")?.value as number,
      unitPriceMinor: field(p.fields, "unit_price_minor")?.value as number,
    }));
    expect(tieOut({ lines, printedTotalMinor: 108000 }).residualMinor).toBe(0);
    expect(tieOut({ lines: lines.slice(0, 2), printedTotalMinor: 108000 }).residualMinor).toBe(
      8000,
    );
  });

  it("makes a value the line's excerpt does not show NO_ANSWER", async () => {
    const { proposals } = await amounts("invoice", {
      ...invoiceInput,
      lines: [
        {
          description: "Delivery",
          quantity: 3,
          price_minor: 99900,
          source_excerpt: "1 x Delivery @ 100.00",
          confidence: 0.9,
          missing: [],
        },
      ],
    });
    expect(field(proposals[1]?.fields ?? [], "quantity")?.refusal).toBe("NO_ANSWER");
    expect(field(proposals[1]?.fields ?? [], "unit_price_minor")?.refusal).toBe("NO_ANSWER");
  });

  it("keeps a receipt to one suggestion, with its items and tie-out in the answer", async () => {
    const { result, proposals } = await amounts("receipt", {
      fields: [
        rawField("description", "Hardware", "Corner Hardware"),
        rawField("amount_minor", 3240, "Total USD 32.40"),
        rawField("currency_code", "USD", "USD"),
        rawField("incurred_on", "2027-03-14", "03/14/2027"),
      ],
      read: [rawField("printed_tax_minor", 240, "Tax 2.40")],
      lines: [
        {
          description: "Gaff tape",
          quantity: 2,
          price_minor: 2400,
          source_excerpt: "Gaff tape 2 x 24.00",
          confidence: 0.9,
          missing: [],
        },
        {
          description: "Zip ties",
          quantity: null,
          price_minor: 600,
          source_excerpt: "Zip ties 6.00",
          confidence: 0.9,
          missing: [],
        },
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(result.kind === "answer" && result.value.line_items).toHaveLength(2);
    expect(result.kind === "answer" && result.value.tie_out).toMatchObject({
      status: "ties",
      printedTaxMinor: 240,
    });
  });
});

const SECTIONS: readonly DraftableSection[] = [
  {
    id: "s_text",
    title: "Hospitality",
    prompt: "Tell us.",
    kind: "Text",
    window_kind: null,
    max_lines: null,
    choices: [],
  },
  {
    id: "s_win",
    title: "Load In",
    prompt: null,
    kind: "Schedule Window",
    window_kind: "Load In",
    max_lines: 1,
    choices: [],
  },
  {
    id: "s_item",
    title: "Radios",
    prompt: null,
    kind: "Item Request",
    window_kind: null,
    max_lines: 1,
    choices: [{ id: "c_radio", name: "Radio" }],
  },
];

const MAIL =
  "Hospitality: two cases of water. We load in Mar 14 2027 01:30 to Mar 14 2027 03:30. We need 4 radios.";

const answers = async (
  input: unknown,
  source?: Parameters<typeof draftAdvanceAnswers>[1]["source"],
) => {
  const { store, log } = memoryStore();
  const model = new ScriptedModel([toolCall("draft_advance_answers", input)]);
  const result = await draftAdvanceAnswers(context(model, store), {
    recipientId: "r1",
    sections: SECTIONS,
    timeZone: "America/New_York",
    projectToday: "2027-01-04",
    source: source ?? { kind: "Project Inbox", messageId: "m1", body: MAIL },
    verbiage: [{ term: "loading dock", preferred: "Dock" }],
    neverSend: new NeverSendList([]),
  });
  return { result, log, model, proposals: log.proposed.map((p) => p.change) };
};

const textAnswer = {
  section_id: "s_text",
  text: "Two cases of water.",
  source_excerpt: "Hospitality: two cases of water.",
  confidence: 0.9,
};

describe("drafted advance answers", () => {
  it("sends only the source, the sections and choices, the zone and the verbiage library", async () => {
    const { model } = await answers({ answers: [textAnswer], unanswered: [] });
    const request = model.requests[0];
    const content = request?.messages[0]?.content ?? [];
    expect(content[0]).toMatchObject({ type: "document", mediaType: "text/plain" });
    const text = JSON.stringify(content.slice(1));
    expect(text).toContain("c_radio");
    expect(text).not.toMatch(/roster|allerg|profile/i);
    expect(request?.system).toContain("America/New_York");
    expect(request?.system).toContain("Dock");
  });

  it("stores one suggestion per valid answer, with the section as its target", async () => {
    const { proposals, result } = await answers({
      answers: [
        textAnswer,
        {
          section_id: "s_win",
          lines: [
            { local_start: "2027-03-14T01:30", local_end: "2027-03-14T03:30", note: "gate B" },
          ],
          source_excerpt: "We load in Mar 14 2027 01:30 to Mar 14 2027 03:30.",
          confidence: 0.8,
        },
        {
          section_id: "s_item",
          lines: [{ choice_id: "c_radio", quantity: 4 }],
          source_excerpt: "We need 4 radios.",
          confidence: 0.8,
        },
      ],
      unanswered: [],
    });
    expect(proposals.map((p) => [p.operationId, p.targetId])).toEqual([
      ["advanceAnswers.record", "s_text"],
      ["advanceAnswers.record", "s_win"],
      ["advanceAnswers.record", "s_item"],
    ]);
    expect(field(proposals[0]?.fields ?? [], "source_kind")).toMatchObject({
      value: "Project Inbox",
      source_excerpt: "Hospitality: two cases of water.",
    });
    expect(field(proposals[0]?.fields ?? [], "inbound_message_id")?.value).toBe("m1");
    // A window across the change of the clocks, in the project's zone; its note is dropped, not offered.
    expect(field(proposals[1]?.fields ?? [], "lines")?.value).toEqual([
      {
        needed_window_start: "2027-03-14T06:30:00.000Z",
        needed_window_end: "2027-03-14T07:30:00.000Z",
        window_zone: "America/New_York",
      },
    ]);
    expect(result.kind === "answer" && result.value.unanswered).toEqual([]);
  });

  it("drops an excerpt the mail does not hold, and reports it", async () => {
    const { result } = await answers({
      answers: [
        textAnswer,
        {
          section_id: "s_item",
          lines: [{ choice_id: "c_radio", quantity: 4 }],
          source_excerpt: "We need 4 radios please.",
          confidence: 0.8,
        },
      ],
      unanswered: [],
    });
    expect(result.kind === "answer" && result.value.dropped).toEqual([
      { section_id: "s_item", reason: "excerpt" },
    ]);
  });

  it("normalizes whitespace when it looks for the excerpt", async () => {
    const { result } = await answers({
      answers: [{ ...textAnswer, source_excerpt: "Hospitality:   two cases\nof water." }],
      unanswered: [],
    });
    expect(result.kind === "answer" && result.value.dropped).toEqual([]);
  });

  it.each([
    [
      "a foreign section",
      { section_id: "nope", text: "x", source_excerpt: "We need 4 radios.", confidence: 0.8 },
      "section",
    ],
    [
      "a foreign choice",
      {
        section_id: "s_item",
        lines: [{ choice_id: "c_other", quantity: 4 }],
        source_excerpt: "We need 4 radios.",
        confidence: 0.8,
      },
      "choice",
    ],
    [
      "a quantity the excerpt does not show",
      {
        section_id: "s_item",
        lines: [{ choice_id: "c_radio", quantity: 9 }],
        source_excerpt: "We need 4 radios.",
        confidence: 0.8,
      },
      "quantity",
    ],
    [
      "lines beyond max_lines",
      {
        section_id: "s_item",
        lines: [
          { choice_id: "c_radio", quantity: 4 },
          { choice_id: "c_radio", quantity: 4 },
        ],
        source_excerpt: "We need 4 radios.",
        confidence: 0.8,
      },
      "too_many",
    ],
    [
      "no excerpt at all",
      { section_id: "s_item", lines: [{ choice_id: "c_radio", quantity: 4 }], confidence: 0.8 },
      "excerpt",
    ],
    [
      "a window ending before it starts",
      {
        section_id: "s_win",
        lines: [{ local_start: "2027-03-14T03:30", local_end: "2027-03-14T01:30" }],
        source_excerpt: "We load in Mar 14 2027 01:30 to Mar 14 2027 03:30.",
        confidence: 0.8,
      },
      "time",
    ],
  ])("drops %s and keeps the rest", async (_name, bad, reason) => {
    const { result, proposals } = await answers({ answers: [textAnswer, bad], unanswered: [] });
    expect(proposals).toHaveLength(1);
    expect(result.kind === "answer" && result.value.dropped).toEqual([
      { section_id: (bad as { section_id: string }).section_id, reason },
    ]);
  });

  it("lists what is left unanswered, with the model's reason or a plain one", async () => {
    const { result } = await answers({
      answers: [textAnswer],
      unanswered: [{ section_id: "s_win", missing: "No load-in time is given." }],
    });
    expect(result.kind === "answer" && result.value.unanswered).toEqual([
      { section_id: "s_win", missing: "No load-in time is given." },
      { section_id: "s_item", missing: "The source does not answer this section." },
    ]);
  });

  it("answers no-answer when nothing is answered, storing nothing", async () => {
    const { result, proposals } = await answers({ answers: [], unanswered: [] });
    expect(result.kind).toBe("no-answer");
    expect(proposals).toHaveLength(0);
  });

  it("fails when cut off at the token limit", async () => {
    const { store, log } = memoryStore();
    const model = new ScriptedModel([cutOff("draft_advance_answers", { answers: [textAnswer] })]);
    const result = await draftAdvanceAnswers(context(model, store), {
      recipientId: "r1",
      sections: SECTIONS,
      timeZone: "America/New_York",
      projectToday: "2027-01-04",
      source: { kind: "Project Inbox", messageId: "m1", body: MAIL },
      verbiage: [],
      neverSend: new NeverSendList([]),
    });
    expect(result).toMatchObject({ kind: "failed", code: "model_output_invalid" });
    expect(log.proposed).toHaveLength(0);
  });

  it("holds a text file to its excerpt, and says a PDF cannot be checked", async () => {
    const text = await answers(
      { answers: [{ ...textAnswer, source_excerpt: "not in the file" }], unanswered: [] },
      { kind: "File", fileName: "reply.txt", document: document(MAIL) },
    );
    expect(text.result.kind).toBe("no-answer");
    const pdf = await answers(
      { answers: [{ ...textAnswer, source_excerpt: "anything" }], unanswered: [] },
      {
        kind: "File",
        fileName: "reply.pdf",
        document: { type: "document", mediaType: "application/pdf", data: "JVBERi0=" },
      },
    );
    expect(pdf.result.kind === "answer" && pdf.result.value.answers[0]?.excerpt_checked).toBe(
      false,
    );
    expect(field(pdf.proposals[0]?.fields ?? [], "file_name")?.value).toBe("reply.pdf");
  });
});

describe("governance drafts", () => {
  it.each(["event_plan", "event_brief", "approval_pack", "waste_plan"] as const)(
    "%s goes through draft() with no suggestions",
    async (kind) => {
      const { store, log } = memoryStore();
      const model = new ScriptedModel([
        toolCall("draft", {
          title: "Plan",
          body: "## Overview\n[needs: the capacity]",
          gaps: ["the capacity"],
        }),
      ]);
      const result = await draft(context(model, store), {
        kind,
        instructions: "Draft it.",
        context: [{ id: "p1", table: "app.projects", data: { name: "Harbor" } }],
        verbiage: [],
        neverSend: new NeverSendList([]),
        subject: { table: "app.records", id: "r1" },
      });
      expect(result.kind === "answer" && result.value.gaps).toEqual(["the capacity"]);
      expect(log.proposed).toHaveLength(0);
      expect(log.begun[0]?.subject).toEqual({ table: "app.records", id: "r1" });
    },
  );

  it("tells a waste plan to write Unmeasured and never to state approval", async () => {
    const { store } = memoryStore();
    const model = new ScriptedModel([
      toolCall("draft", { title: "W", body: "x", gaps: [] }),
      toolCall("draft", { title: "A", body: "x", gaps: [] }),
    ]);
    const base = {
      instructions: "Draft it.",
      context: [],
      verbiage: [],
      neverSend: new NeverSendList([]),
      subject: null,
    };
    await draft(context(model, store), { ...base, kind: "waste_plan" });
    await draft(context(model, store), { ...base, kind: "approval_pack" });
    expect(model.requests[0]?.system).toContain("write Unmeasured");
    expect(model.requests[1]?.system).toContain(
      "Never state that anything is approved, signed or compliant",
    );
  });
});
