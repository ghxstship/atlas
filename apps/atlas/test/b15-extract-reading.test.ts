import { describe, expect, it } from "vitest";
import { rejectedOnFill, splitReading } from "@/lib/aurora/extract-reading";
import { FixtureModelClient } from "@/lib/aurora/fixture-model";
import { toolInput } from "./aurora-tool-input";

describe("one reading of an invoice (B15)", () => {
  const suggestions = [
    { suggestion_id: "h", operation_id: "invoices.create" },
    { suggestion_id: "l1", operation_id: "invoiceLines.create" },
    { suggestion_id: "l2", operation_id: "invoiceLines.create" },
  ];

  it("leaves invoice lines open: not the header, not loaded, not in the form's fields", () => {
    expect(splitReading(suggestions)).toEqual({ loaded: ["h"], deferred: ["l1", "l2"] });
  });

  it("keeps a quote's lines in the panel", () => {
    expect(
      splitReading([
        { suggestion_id: "h", operation_id: "rfqResponses.create" },
        { suggestion_id: "l", operation_id: "rfqResponseLines.create" },
      ]),
    ).toEqual({ loaded: ["h", "l"], deferred: [] });
  });

  it("rejects an earlier reading's open lines when a new reading replaces it", () => {
    expect(
      rejectedOnFill({ kept: ["h2"], filled: ["h1"], deferred: ["l1", "l2"], lines: [] }),
    ).toEqual(["h1", "l1", "l2"]);
  });

  it("rejects lines the person left out, and nothing kept", () => {
    expect(
      rejectedOnFill({ kept: ["h", "q1"], filled: ["h"], deferred: [], lines: ["q1", "q2"] }),
    ).toEqual(["q2"]);
  });
});

describe("the B15 fixtures read what the journeys send", () => {
  const model = new FixtureModelClient();
  const read = (kind: string, text: string, extra = "") =>
    model.complete({
      model: "fixture",
      system: `Task: read the attached ${kind} and fill the fields below.\n${extra}`,
      maxTokens: 100,
      messages: [
        { role: "user", content: [{ type: "document", mediaType: "text/plain", data: text }] },
      ],
      tools: [{ name: "record_fields", description: "", inputSchema: {} }],
      toolChoice: { type: "tool", name: "record_fields" },
    });

  it("reads an itinerary's passengers and leg", async () => {
    const input = toolInput(
      await read(
        "itinerary",
        "Passenger: Dana Kim\nFlight GA 12 Mar 12 2029 08:15 MIA to ORD Mar 12 2029 10:30\n",
      ),
    ) as { segments: { passengers: { name: string }[]; departs_local: string }[] };
    expect(input.segments[0]?.passengers).toEqual([{ name: "Dana Kim" }]);
    expect(input.segments[0]?.departs_local).toBe("2029-03-12T08:15");
  });

  it("reads a fee only when the prompt asks for one", async () => {
    const text =
      "ARTIST BOOKING AGREEMENT\nArtist: Owls\nPerformance date: 2029-06-05\nGuarantee: USD 7,500.00\n";
    const hidden = toolInput(await read("contract", text)) as { fields: { field_path: string }[] };
    expect(hidden.fields.map((f) => f.field_path)).not.toContain("agreed_rate_minor");
    const shown = toolInput(await read("contract", text, "agreed_rate_minor")) as typeof hidden;
    expect(shown.fields.map((f) => f.field_path)).toContain("agreed_rate_minor");
  });

  it("answers what a reply answers, and lists the rest", async () => {
    const response = await model.complete({
      model: "fixture",
      system: "Draft.",
      maxTokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", mediaType: "text/plain", data: "Hospitality: two cases of water." },
            {
              type: "text",
              text: `<data source="sections">\n${JSON.stringify([
                { id: "s1", title: "Hospitality", kind: "Text", choices: [] },
                { id: "s2", title: "Parking", kind: "Text", choices: [] },
              ])}\n</data>`,
            },
          ],
        },
      ],
      tools: [{ name: "draft_advance_answers", description: "", inputSchema: {} }],
      toolChoice: { type: "tool", name: "draft_advance_answers" },
    });
    const input = toolInput(response) as {
      answers: { section_id: string }[];
      unanswered: { section_id: string }[];
    };
    expect(input.answers.map((a) => a.section_id)).toEqual(["s1"]);
    expect(input.unanswered.map((u) => u.section_id)).toEqual(["s2"]);
  });
});
