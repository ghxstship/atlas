import {
  draft,
  draftAdvanceAnswers,
  extractDocument,
  loadModelConfig,
  NeverSendList,
  type AuroraContext,
  type AuroraStore,
  type ProposedChange,
} from "@xos/ai";
import { describe, expect, it } from "vitest";
import { FixtureModelClient } from "@/lib/aurora/fixture-model";

/**
 * The B15 journeys' fixture answers (lib/aurora/fixture-intake.ts) run through the real feature code:
 * the silence rule, the fee only for a payroll reader, the outline, and unanswered sections.
 */

function context(): { ctx: AuroraContext; proposals: ProposedChange[] } {
  const proposals: ProposedChange[] = [];
  const store: AuroraStore = {
    begin: async () => ({ ok: true, data: "req" }),
    complete: async () => ({ ok: true, data: null }),
    propose: async (_id, change) => {
      proposals.push(change);
      return { ok: true, data: `s${proposals.length}` };
    },
  };
  return {
    ctx: {
      orgId: "o",
      client: new FixtureModelClient(),
      store,
      config: loadModelConfig({}),
      today: "2031-05-01",
    },
    proposals,
  };
}
const text = (data: string) => ({
  type: "document" as const,
  mediaType: "text/plain" as const,
  data,
});

describe("B15 fixture answers", () => {
  it("reads the journey itinerary into one segment per passenger and flight", async () => {
    const { ctx, proposals } = context();
    const result = await extractDocument(ctx, {
      kind: "itinerary",
      document: text(
        "Passenger: Riley Ortega\nFlight GA 100 departs MIA 2031-06-01 08:15 arrives ORD 2031-06-01 10:20\n",
      ),
      fileName: "trip.txt",
      subject: { table: "app.ai_intake_batches", id: "b" },
    });
    expect(result.kind).toBe("answer");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.fields.find((f) => f.field_path === "departs_local")).toMatchObject({
      value: "2031-06-01T08:15",
    });
    expect(proposals[0]?.fields.find((f) => f.field_path === "arrives_time_zone")).toMatchObject({
      value: "America/Chicago",
    });
  });

  it("reads a contract's fee only for a payroll reader", async () => {
    const doc = text(
      "Artist: Tidewater Catering\nEngagement date: 2031-08-01\nGuarantee: USD 5,000.00\n",
    );
    const reader = context();
    await extractDocument(reader.ctx, {
      kind: "contract",
      document: doc,
      fileName: "c.txt",
      subject: null,
      readable: ["data.restricted.read.payroll"],
    });
    expect(reader.proposals[0]?.fields.find((f) => f.field_path === "fee_minor")).toMatchObject({
      value: 500000,
    });
    const other = context();
    await extractDocument(other.ctx, {
      kind: "contract",
      document: doc,
      fileName: "c.txt",
      subject: null,
    });
    expect(other.proposals[0]?.fields.find((f) => f.field_path === "fee_minor")).toMatchObject({
      refusal: "NO_ANSWER",
    });
  });

  it("reads invoice lines and the printed total, and an intake rider with its act", async () => {
    const lines = context();
    const result = await extractDocument(lines.ctx, {
      kind: "invoice_lines",
      document: text("2 x Stage deck rental @ $150.00\n1 x Delivery @ $50.00\nTotal $360.00 USD\n"),
      fileName: "i.txt",
      subject: null,
      invoiceCurrency: "USD",
    });
    expect(lines.proposals).toHaveLength(2);
    expect(result).toMatchObject({
      value: { tie_out: { totalResidualMinor: 1000, status: "residual" } },
    });
    const rider = context();
    await extractDocument(rider.ctx, {
      kind: "intake_rider",
      document: text("TECHNICAL RIDER\nArtist: Tidewater Catering\n2 x wedge monitors\n"),
      fileName: "r.txt",
      subject: null,
    });
    expect(rider.proposals.map((p) => p.operationId)).toEqual([
      "riders.create",
      "riderLines.create",
    ]);
  });

  it("drafts a Text answer from a tour book and leaves the rest unanswered", async () => {
    const { ctx } = context();
    const result = await draftAdvanceAnswers(ctx, {
      recipientId: "r",
      sections: [
        {
          id: "s1",
          title: "Load In Notes",
          prompt: null,
          kind: "Text",
          window_kind: null,
          max_lines: null,
          per_person: false,
          choices: [],
        },
        {
          id: "s2",
          title: "Load In",
          prompt: null,
          kind: "Schedule Window",
          window_kind: "Load In",
          max_lines: 1,
          per_person: false,
          choices: [],
        },
      ],
      roster: [],
      timeZone: "America/New_York",
      source: {
        kind: "document",
        document: text("Two trucks arrive at the dock at 07:00.\n"),
        fileName: "tour-book.txt",
      },
      neverSend: new NeverSendList([]),
    });
    expect(result).toMatchObject({ kind: "answer", value: { unanswered: ["s2"] } });
  });

  it("drafts a governance plan to its outline with gaps", async () => {
    const { ctx } = context();
    const result = await draft(ctx, {
      kind: "waste_plan",
      instructions: "Draft the waste plan.",
      context: [],
      verbiage: [],
      neverSend: new NeverSendList([]),
      subject: null,
      outline: ["Waste Streams", "Reporting"],
    });
    expect(result).toMatchObject({ kind: "answer", value: { missingHeadings: [] } });
    expect(result.kind === "answer" ? result.value.gaps.length : 0).toBeGreaterThan(0);
  });
});
