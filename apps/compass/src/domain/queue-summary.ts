/**
 * The offline queue in words a crew member reads (Section 13 visible queue, SIM-002). Each queued RPC
 * becomes one sentence, such as "Clock in at 10:51 PM, Northwind Summer Series", chosen per RPC from its
 * named arguments. Device-only fields (monotonic reading, boot id, local file paths, PINs) and ids never
 * appear: an argument either feeds a sentence or stays out.
 *
 * The functions return a message key under compass.queue.summary and its values, so the screen translates
 * them; formatting of times and names comes from the context.
 */
import type { Mutation, Row } from "@xos/sync";
import { formatNoteLength } from "./incidents";

export interface QueueSummary {
  /** Key under compass.queue.summary. */
  readonly key: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface SummaryContext {
  /** "10:51 PM": a wall time in the device's locale. */
  readonly time: (iso: string, timeZone?: string | null) => string;
  /** "Fri, Mar 12". */
  readonly day: (iso: string, timeZone?: string | null) => string;
  readonly projectName: (id: string) => string | null;
  readonly zoneName: (id: string) => string | null;
  /** The translated name of a punch kind ("Clock in"), keyed In, Break Start, Break End, Out. */
  readonly punchAction: (kind: string) => string;
  /** The translated record kind for a local table ("Clock punch"); the fallback sentence names it. */
  readonly kind: (table: string) => string;
}

type Args = Readonly<Record<string, unknown>>;

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Workforce RPCs whose one readable argument is worth a sentence. */
const WORKFORCE_TEXT: Readonly<Record<string, { key: string; arg: string }>> = {
  "app.send_chat_message": { key: "chatMessage", arg: "p_body" },
  "app.recognize": { key: "recognition", arg: "p_message" },
  "app.log_lost_item": { key: "lostItem", arg: "p_description" },
};

function generic(m: Pick<Mutation, "table" | "queuedAt">, ctx: SummaryContext): QueueSummary {
  return { key: "generic", values: { kind: ctx.kind(m.table), time: ctx.time(m.queuedAt) } };
}

function punch(kind: unknown, at: unknown, projectId: unknown, ctx: SummaryContext): QueueSummary {
  const action = ctx.punchAction(String(kind));
  const time = text(at) ? ctx.time(String(at)) : "";
  const project = text(projectId) ? ctx.projectName(String(projectId)) : null;
  return project
    ? { key: "punch", values: { action, time, project } }
    : { key: "punchNoProject", values: { action, time } };
}

function shift(
  verb: "shiftAccept" | "shiftClaim",
  row: Row | null,
  ctx: SummaryContext,
): QueueSummary {
  const starts = row ? text(row["starts_at"]) : null;
  if (!row || !starts) return { key: `${verb}Unknown`, values: {} };
  const tz = text(row["time_zone"]);
  const ends = text(row["ends_at"]);
  return {
    key: verb,
    values: {
      day: ctx.day(starts, tz),
      start: ctx.time(starts, tz),
      end: ends ? ctx.time(ends, tz) : "",
    },
  };
}

/** One readable sentence for a queued write. */
export function summarizeMutation(
  m: Pick<Mutation, "op" | "target" | "table" | "payload" | "base" | "queuedAt">,
  ctx: SummaryContext,
): QueueSummary {
  const a: Args = m.payload;
  if (m.op === "rpc") {
    switch (m.target) {
      case "app.record_punch":
        return punch(a["p_punch_kind"], a["p_device_time"], a["p_project_id"], ctx);
      case "kiosk-punch":
        return {
          key: "kioskPunch",
          values: {
            action: ctx.punchAction(String(a["punchKind"])),
            time: text(a["deviceAt"]) ? ctx.time(String(a["deviceAt"])) : "",
          },
        };
      case "app.accept_shift":
      case "accept_engaged_shift":
        return shift("shiftAccept", m.base, ctx);
      case "app.claim_open_shift":
        return shift("shiftClaim", m.base, ctx);
      case "app.report_incident": {
        const title = text(a["p_title"]);
        const at = text(a["p_occurred_at"]);
        return title && at
          ? { key: "incidentReport", values: { title, time: ctx.time(at) } }
          : generic(m, ctx);
      }
      case "app.add_incident_media": {
        const at = text(a["p_captured_at"]);
        const time = at ? ctx.time(at) : "";
        if (a["p_media_kind"] === "Voice Note" && typeof a["p_duration_ms"] === "number")
          return {
            key: "incidentVoiceNote",
            values: { time, length: formatNoteLength(a["p_duration_ms"]) },
          };
        return { key: "incidentPhoto", values: { time } };
      }
      case "app.add_incident_party": {
        const description = text(a["p_description"]);
        return description ? { key: "incidentParty", values: { description } } : generic(m, ctx);
      }
      case "app.transition_incident":
      case "app.transition_fulfillment": {
        const next = text(a["p_next"]);
        const key = m.target === "app.transition_incident" ? "incidentMove" : "fulfillmentMove";
        return next ? { key, values: { state: next } } : generic(m, ctx);
      }
      case "record_scan": {
        const zone = text(a["p_zone_id"]) ? ctx.zoneName(String(a["p_zone_id"])) : null;
        const at = text(a["p_device_scanned_at"]);
        const time = at ? ctx.time(at) : ctx.time(m.queuedAt);
        return zone
          ? { key: "accessScanZone", values: { zone, time } }
          : { key: "accessScan", values: { time } };
      }
      case "app.apply_asset_scan": {
        const code = text(a["p_code"]) ?? "";
        return {
          key: a["p_action"] === "check-in" ? "assetReturn" : "assetCheckOut",
          values: { code },
        };
      }
      case "app.record_inspection_result":
        return { key: "inspectionAnswer", values: {} };
      case "app.call_cue": {
        const label = m.base ? text(m.base["label"]) : null;
        return label
          ? { key: "cueCall", values: { label } }
          : { key: "cueCallUnknown", values: {} };
      }
      case "app.record_gate_arrival": {
        const vehicle = text(a["p_vehicle_identifier"]);
        return vehicle ? { key: "gateArrival", values: { vehicle } } : generic(m, ctx);
      }
      case "app.release_vehicle":
        return { key: "vehicleRelease", values: {} };
      case "app.check_in_dock_slot":
        return { key: "dockCheckIn", values: {} };
      case "app.add_marshalling_entry": {
        const entry = text(a["p_entry"]);
        return entry ? { key: "marshalling", values: { entry } } : generic(m, ctx);
      }
      default: {
        const spec = m.target ? WORKFORCE_TEXT[m.target] : undefined;
        const value = spec ? text(a[spec.arg]) : null;
        return spec && value ? { key: spec.key, values: { text: value } } : generic(m, ctx);
      }
    }
  }
  switch (m.table) {
    case "inspections":
      return m.op === "insert"
        ? {
            key: "inspectionStart",
            values: { time: ctx.time(text(a["inspected_at"]) ?? m.queuedAt) },
          }
        : { key: "inspectionSignOff", values: {} };
    case "inspection_results":
      return { key: "inspectionAnswer", values: {} };
    case "scan_intake": {
      const code = text(a["scanned_value"]);
      return code ? { key: "scanIntake", values: { code } } : generic(m, ctx);
    }
    default:
      return generic(m, ctx);
  }
}

/** Postgres and PostgREST wording a crew member should never read. */
const TECHNICAL =
  /violates|row-level security|permission denied|relation "|column "|syntax error|duplicate key|null value in column|invalid input syntax|PGRST|SQLSTATE|Exception|fetch failed|\.swift:|\.kt:/i;

/**
 * Why the server refused a queued write, in words. Rule refusals read "rule_code: sentence" and show the
 * sentence. A permission refusal (42501) and any raw database wording get a plain sentence instead (on
 * the simulator the queue printed 'new row violates row-level security policy for table "inspections"').
 */
export function refusalReason(error: {
  readonly code: string;
  readonly message: string;
}): QueueSummary {
  if (error.code === "42501" || /row-level security|permission denied/i.test(error.message)) {
    return { key: "refusedPermission", values: {} };
  }
  const sentence = error.message.replace(/^[a-z][a-z0-9_]*:\s+/, "").trim();
  if (!sentence || TECHNICAL.test(sentence)) return { key: "refusedTechnical", values: {} };
  return { key: "refusedReason", values: { reason: sentence } };
}

/**
 * The server's version, reported with a conflict, in the same words. Rows the device can describe get a
 * sentence; any other row says the server holds a different version, never its raw columns.
 */
export function summarizeServerRow(table: string, row: Row, ctx: SummaryContext): QueueSummary {
  switch (table) {
    case "clock_punches":
      return punch(
        row["punch_kind"],
        row["effective_at"] ?? row["device_time"],
        row["project_id"],
        ctx,
      );
    case "shifts": {
      const starts = text(row["starts_at"]);
      const state = text(row["shift_state"]);
      if (!starts || !state) break;
      const tz = text(row["time_zone"]);
      return {
        key: "serverShift",
        values: { state, day: ctx.day(starts, tz), start: ctx.time(starts, tz) },
      };
    }
    case "incidents":
    case "fulfillments": {
      const state = text(row["incident_state"] ?? row["fulfillment_state"]);
      const title = text(row["title"]) ?? ctx.kind(table);
      if (state) return { key: "serverState", values: { title, state } };
      break;
    }
    case "cues": {
      const label = text(row["label"]);
      const called = text(row["called_at"]);
      if (label && called) return { key: "serverCue", values: { label, time: ctx.time(called) } };
      break;
    }
  }
  return { key: "serverGeneric", values: { kind: ctx.kind(table) } };
}
