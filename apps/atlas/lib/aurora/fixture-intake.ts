import type { ModelRequest, ModelResponse } from "@xos/ai";
import { toolCall } from "./fixture-entry";

/**
 * The fixture model's B15 documents (RRR-239), for the journeys of apps/atlas/e2e/b15-aurora-intake.spec.ts.
 * It reads the plain-text formats those journeys send, as a model would: every value it returns is
 * in the document, and the real feature code still holds each to its excerpt.
 */

const ZONES: Readonly<Record<string, string>> = {
  MIA: "America/New_York",
  JFK: "America/New_York",
  ORD: "America/Chicago",
  LAX: "America/Los_Angeles",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 12 2027 08:15" as YYYY-MM-DDTHH:MM. */
const local = (month: string, day: string, year: string, time: string) =>
  `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, "0")}-${day.padStart(2, "0")}T${time}`;

const FLIGHT =
  /^Flight (\S+ \d+) ([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) (\d{2}:\d{2}) ([A-Z]{3}) to ([A-Z]{3}) ([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) (\d{2}:\d{2})$/;

function readItinerary(text: string): ModelResponse {
  const lines = text.split("\n").map((l) => l.trim());
  const passengers = lines
    .filter((l) => l.startsWith("Passenger: "))
    .map((l) => ({ name: l.slice("Passenger: ".length) }));
  const segments = lines.flatMap((line) => {
    const m = FLIGHT.exec(line);
    if (!m) return [];
    const [, service, mo1, d1, y1, t1, from, to, mo2, d2, y2, t2] = m as unknown as string[];
    return [
      {
        passengers,
        travel_mode: "Flight",
        operator_name: null,
        service_identifier: service,
        confirmation_identifier: null,
        departs_from: from,
        arrives_at_place: to,
        departs_local: local(mo1 as string, d1 as string, y1 as string, t1 as string),
        arrives_local: local(mo2 as string, d2 as string, y2 as string, t2 as string),
        departs_time_zone: ZONES[from as string] ?? null,
        arrives_time_zone: ZONES[to as string] ?? null,
        source_excerpt: line,
        confidence: 0.9,
        missing: [],
      },
    ];
  });
  return toolCall("record_fields", { segments });
}

const value = (path: string, v: string | number, excerpt: string) => ({
  field_path: path,
  value: v,
  confidence: 0.9,
  source_excerpt: excerpt,
  missing: null,
});

function readContract(request: ModelRequest, text: string): ModelResponse {
  const lines = text.split("\n").map((l) => l.trim());
  const first = lines[0] ?? "";
  const fields = [
    value(
      "document_type",
      /RIDER/.test(first) ? "Rider" : /AGREEMENT|CONTRACT/.test(first) ? "Contract" : "Other",
      first,
    ),
    value(
      "title",
      first.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()),
      first,
    ),
  ];
  for (const line of lines) {
    const act = /^Artist: (.+)$/.exec(line);
    if (act?.[1]) fields.push(value("act_name", act[1], line));
    const date = /^Performance date: (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (date?.[1]) fields.push(value("start_date", date[1], line));
    const fee = /^Guarantee: ([A-Z]{3}) ([\d,]+)\.(\d{2})$/.exec(line);
    if (fee?.[1] && request.system.includes("agreed_rate_minor")) {
      fields.push(
        value(
          "agreed_rate_minor",
          Number(`${(fee[2] ?? "").replaceAll(",", "")}${fee[3] ?? ""}`),
          line,
        ),
      );
      fields.push(value("agreed_rate_currency_code", fee[1], line));
    }
  }
  return toolCall("record_fields", { fields, lines: [] });
}

const minorOf = (text: string) => Number(text.replaceAll(",", "").replace(".", ""));

/** An invoice with "Line:" rows, and its printed totals. */
function readInvoice(text: string): ModelResponse | null {
  if (!/^Line: /m.test(text)) return null;
  const lines = text.split("\n").map((l) => l.trim());
  const fields = [];
  const read = [];
  const rows = [];
  for (const line of lines) {
    const number = /^Invoice (\S+)$/.exec(line);
    if (number?.[1]) fields.push(value("invoice_number", number[1], line));
    const currency = /^Currency: ([A-Z]{3})$/.exec(line);
    if (currency?.[1]) fields.push(value("currency_code", currency[1], line));
    const total = /^Total ([\d,.]+)$/.exec(line);
    if (total?.[1]) fields.push(value("printed_total_minor", minorOf(total[1]), line));
    const tax = /^Tax ([\d,.]+)$/.exec(line);
    if (tax?.[1]) read.push(value("printed_tax_minor", minorOf(tax[1]), line));
    const row = /^Line: (\d+) x (.+) @ ([\d,.]+)$/.exec(line);
    if (row?.[1] && row[2] && row[3]) {
      rows.push({
        description: row[2],
        quantity: Number(row[1]),
        price_minor: minorOf(row[3]),
        source_excerpt: line,
        confidence: 0.9,
        missing: [],
      });
    }
  }
  return toolCall("record_fields", { fields, read, lines: rows });
}

/** Itineraries, contracts and invoices with lines; null leaves the document to the other fixtures. */
export function fixtureIntake(request: ModelRequest, text: string): ModelResponse | null {
  if (request.system.includes("read the attached itinerary")) return readItinerary(text);
  if (request.system.includes("read the attached contract")) return readContract(request, text);
  if (request.system.includes("read the attached invoice")) return readInvoice(text);
  return null;
}

interface DraftSection {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly choices: readonly { readonly id: string; readonly name: string }[];
}

/** Answers from "<section title>: ..." lines, "Window <start> to <end>" and "We need <n> <choice>". */
export function fixtureAdvanceAnswers(request: ModelRequest, text: string): ModelResponse {
  const content = request.messages[0]?.content ?? [];
  const block = content.find((c) => c.type === "text" && c.text.includes('source="sections"'));
  const json = block?.type === "text" ? /\[[\s\S]*\]/.exec(block.text)?.[0] : undefined;
  const sections = (json ? JSON.parse(json) : []) as DraftSection[];
  const lines = text.split("\n").map((l) => l.trim());
  const answers = [];
  const unanswered = [];
  for (const section of sections) {
    if (section.kind === "Text") {
      const line = lines.find((l) => l.startsWith(`${section.title}: `));
      if (line) {
        answers.push({
          section_id: section.id,
          text: line.slice(section.title.length + 2),
          source_excerpt: line,
          confidence: 0.9,
        });
        continue;
      }
    } else if (section.kind === "Schedule Window") {
      const line = lines.find((l) => l.startsWith("Window "));
      const m = line
        ? /^Window ([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) (\d{2}:\d{2}) to ([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) (\d{2}:\d{2})$/.exec(
            line,
          )
        : null;
      if (m && line) {
        const [, mo1, d1, y1, t1, mo2, d2, y2, t2] = m as unknown as string[];
        answers.push({
          section_id: section.id,
          lines: [
            {
              local_start: local(mo1 as string, d1 as string, y1 as string, t1 as string),
              local_end: local(mo2 as string, d2 as string, y2 as string, t2 as string),
            },
          ],
          source_excerpt: line,
          confidence: 0.9,
        });
        continue;
      }
    } else {
      const choice = section.choices.find((c) => lines.some((l) => l.includes(c.name)));
      const line = choice ? lines.find((l) => l.includes(choice.name)) : undefined;
      const quantity = line ? /We need (\d+)/.exec(line)?.[1] : undefined;
      if (choice && line && quantity) {
        answers.push({
          section_id: section.id,
          lines: [{ choice_id: choice.id, quantity: Number(quantity) }],
          source_excerpt: line,
          confidence: 0.9,
        });
        continue;
      }
    }
    unanswered.push({ section_id: section.id, missing: "The source does not say." });
  }
  return toolCall("draft_advance_answers", { answers, unanswered });
}
