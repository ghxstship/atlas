import type { ModelContent, ModelRequest, ModelResponse } from "@xos/ai";
import { dataOf, documentKind } from "./fixture-entry";

/**
 * The fixture model's answers for the B15 journeys (RRR-239): itineraries, booking contracts,
 * intake riders and invoice lines read from the journeys' plain-text documents, and advance
 * answers drafted from them. Like the rest of the fixture model (fixture-model.ts) it reads only
 * what the request carries, quotes its excerpts word for word from the document so the silence
 * rule holds, and leaves whatever the document does not print unread. It never runs in production.
 */

const usage = { inputTokens: 0, outputTokens: 0 };

function toolCall(name: string, input: unknown): ModelResponse {
  return {
    content: [{ type: "tool_use", id: `fixture_${name}`, name, input }],
    stopReason: "tool_use",
    usage,
  };
}

const read = (path: string, value: string | number, excerpt: string, confidence = 0.9) => ({
  field_path: path,
  value,
  confidence,
  source_excerpt: excerpt,
  missing: null,
});
const unread = (path: string) => ({
  field_path: path,
  value: null,
  confidence: null,
  source_excerpt: null,
  missing: "The journey document does not print this.",
});

/** The zones of the journeys' airports, as a person would read them from the place. */
const ZONES: Readonly<Record<string, string>> = {
  MIA: "America/New_York",
  JFK: "America/New_York",
  ORD: "America/Chicago",
  LAX: "America/Los_Angeles",
};

const FLIGHT =
  /^Flight (\S+ \d+) departs ([A-Z]{3}) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) arrives ([A-Z]{3}) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/gm;

function itinerary(text: string): ModelResponse {
  const passengers = [...text.matchAll(/^Passenger: (.+)$/gm)].map((m) => m[1]?.trim() ?? "");
  const flights = [...text.matchAll(FLIGHT)];
  const lines = passengers.flatMap((name) =>
    flights.map((f) => {
      const [
        line = "",
        service = "",
        from = "",
        day = "",
        time = "",
        to = "",
        arrivalDay = "",
        arrivalTime = "",
      ] = f;
      return {
        fields: [
          read("passenger_name", name, `Passenger: ${name}`),
          read("travel_mode", "Flight", line),
          read("service_identifier", service, line),
          read("departs_from", from, line),
          read("departs_local", `${day}T${time}`, line),
          ZONES[from]
            ? read("departs_time_zone", ZONES[from] ?? "", line, 0.6)
            : unread("departs_time_zone"),
          read("arrives_at_place", to, line),
          read("arrives_local", `${arrivalDay}T${arrivalTime}`, line),
          ZONES[to]
            ? read("arrives_time_zone", ZONES[to] ?? "", line, 0.6)
            : unread("arrives_time_zone"),
          unread("price_minor"),
        ],
      };
    }),
  );
  return toolCall("record_fields", { fields: [], lines });
}

function contract(text: string, system: string): ModelResponse {
  const act = /^Artist: (.+)$/m.exec(text);
  const date = /^Engagement date: (\d{4}-\d{2}-\d{2})$/m.exec(text);
  const fee = /^Guarantee: USD ([\d,]+)\.00$/m.exec(text);
  return toolCall("record_fields", {
    fields: [
      act ? read("act_name", act[1]?.trim() ?? "", act[0]) : unread("act_name"),
      unread("contracting_party"),
      date ? read("start_date", date[1] ?? "", date[0]) : unread("start_date"),
      date ? read("end_date", date[1] ?? "", date[0]) : unread("end_date"),
      // The fee is asked only of a payroll reader: it is listed in the task only then.
      fee && system.includes("fee_minor")
        ? read("fee_minor", Number((fee[1] ?? "0").replaceAll(",", "")) * 100, fee[0])
        : unread("fee_minor"),
      fee ? read("currency_code", "USD", fee[0]) : unread("currency_code"),
    ],
  });
}

function rider(text: string): ModelResponse {
  const act = /^Artist: (.+)$/m.exec(text);
  const title = /^(TECHNICAL RIDER|HOSPITALITY RIDER)$/m.exec(text);
  const lines = [...text.matchAll(/^(\d+) x (.+)$/gm)].map((m) => ({
    fields: [read("description", m[2]?.trim() ?? "", m[0]), read("quantity", Number(m[1]), m[0])],
  }));
  return toolCall("record_fields", {
    fields: [
      act ? read("act_name", act[1]?.trim() ?? "", act[0]) : unread("act_name"),
      title
        ? read(
            "title",
            title[1] === "TECHNICAL RIDER" ? "Technical Rider" : "Hospitality Rider",
            title[0],
          )
        : unread("title"),
    ],
    lines,
  });
}

function invoiceLines(text: string): ModelResponse {
  const lines = [...text.matchAll(/^(\d+) x (.+) @ \$(\d+)\.(\d{2})$/gm)].map((m) => ({
    fields: [
      read("description", m[2]?.trim() ?? "", m[0]),
      read("quantity", Number(m[1]), m[0]),
      read("unit_price_minor", Number(m[3]) * 100 + Number(m[4]), m[0]),
    ],
  }));
  const total = /^Total \$(\d+)\.(\d{2}) (USD|CAD)$/m.exec(text);
  return toolCall("record_fields", {
    fields: [],
    check: total
      ? [
          read("printed_total_minor", Number(total[1]) * 100 + Number(total[2]), total[0]),
          read("currency_code", total[3] ?? "USD", total[0]),
        ]
      : [unread("printed_total_minor")],
    lines,
  });
}

function documentText(content: readonly ModelContent[]): string {
  const doc = content.find((c) => c.type === "document");
  return doc && doc.type === "document" && doc.mediaType === "text/plain" ? doc.data : "";
}

/** The B15 extraction kinds; null for any other document, which the older fixtures answer. */
export function fixtureIntake(request: ModelRequest): ModelResponse | null {
  const text = documentText(request.messages[0]?.content ?? []);
  const kind = documentKind(request);
  if (kind === "itinerary") return itinerary(text);
  if (kind === "contract") return contract(text, request.system);
  if (kind === "invoice_lines") return invoiceLines(text);
  // An intake rider asks for the act it belongs to; the A95 rider form does not.
  if (kind === "rider" && /^- act_name \(/m.test(request.system)) return rider(text);
  return null;
}

/**
 * Advance answers drafted from the journey's message or file: a Text section takes the first
 * sentence, a Schedule Window section the "YYYY-MM-DD HH:MM to YYYY-MM-DD HH:MM" the source prints,
 * and every other section is unanswered, never invented.
 */
export function fixtureAdvanceAnswers(request: ModelRequest): ModelResponse {
  const content = request.messages[0]?.content ?? [];
  const text = documentText(content);
  const sections = (dataOf(content, "sections") ?? []) as { id: string; kind: string }[];
  const window = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) to (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(
    text,
  );
  const sentence = /^[^.\n]+\./.exec(text.trim())?.[0] ?? "";
  const answers: unknown[] = [];
  const unanswered: string[] = [];
  for (const s of sections) {
    if (s.kind === "Text" && sentence) {
      answers.push({ section_id: s.id, body: sentence, source_excerpt: sentence, confidence: 0.8 });
    } else if (s.kind === "Schedule Window" && window) {
      answers.push({
        section_id: s.id,
        lines: [{ from_local: `${window[1]}T${window[2]}`, to_local: `${window[3]}T${window[4]}` }],
        source_excerpt: window[0],
        confidence: 0.8,
      });
    } else {
      unanswered.push(s.id);
    }
  }
  return toolCall("draft_advance_answers", { answers, unanswered });
}
