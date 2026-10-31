/**
 * What B15's Aurora intake and drafting handlers read before any model call (RRR-239, ADR 0154),
 * kept beside handlers/parts/aurora.ts, which wires them into the operations. Everything here runs
 * in the caller's session: an intake batch, an invoice or a project inbox message the caller cannot
 * read is not found, and the checks that refuse a source come before app.ai_begin_request, so a
 * refused request is never metered.
 */
import type { GovernanceKind, ItineraryLine, PublicApi, StoredProposal } from "@xos/ai";
import type { AiIntake } from "@xos/data/ai";
import { getIntake } from "@xos/data/ai";
import type { ResourceSpec } from "../../catalog/types.ts";
import { notFound, refused } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { requirePerson } from "../../runtime/context.ts";
import { from, run, unwrap, type Row } from "../support/table.ts";

/** The intake kind each extraction kind reads into. */
export const INTAKE_KIND_OF: Readonly<Record<string, "Itineraries" | "Contracts and Riders">> = {
  itinerary: "Itineraries",
  contract: "Contracts and Riders",
  intake_rider: "Contracts and Riders",
};

/** The caller's own intake batch, read under row level security; anyone else's is not found. */
export async function ownIntake(context: RequestContext, id: string): Promise<AiIntake> {
  const batch = unwrap(await getIntake(context.db, id));
  if (batch.created_by !== requirePerson(context)) throw notFound("This intake is not yours.");
  return batch;
}

/** The batch as the API returns it. */
export function intakeBody(batch: AiIntake) {
  return {
    id: batch.id,
    org_id: batch.org_id,
    created_at: batch.created_at,
    created_by: batch.created_by,
    updated_at: batch.updated_at,
    updated_by: batch.updated_by,
    project_id: batch.project_id,
    intake_kind: batch.intake_kind,
    fulfillment_id: batch.fulfillment_id,
    file_count: batch.file_count,
    closed_at: batch.closed_at,
    requests: batch.requests,
    suggestions: batch.suggestions,
  };
}

const SOURCE_INVALID =
  "Aurora drafts from a verified message in this project's inbox that you can read.";

export interface InboxMessage {
  readonly id: string;
  readonly projectId: string;
  readonly subject: string | null;
  readonly body: string;
}

/**
 * A project inbox message the caller can read (knowledge.document.write on the inbox's project),
 * verified by DKIM, not Rejected or discarded, in the inbox of `projectId`; otherwise
 * aurora_draft_source_invalid. Reply mail is never a source.
 */
export async function readInboxMessage(
  context: RequestContext,
  id: string,
  projectId: string,
): Promise<InboxMessage> {
  const message = (
    await run<Row[]>(
      from(context.db, "inbound_messages")
        .select(
          "id, purpose, dkim_verified, inbound_status, discarded_at, subject_line, body_text, inbound_address_id",
        )
        .eq("id", id)
        .is("deleted_at", null),
    )
  )[0];
  const address = message?.["inbound_address_id"]
    ? (
        await run<Row[]>(
          from(context.db, "inbound_addresses")
            .select("project_id")
            .eq("id", String(message["inbound_address_id"])),
        )
      )[0]
    : undefined;
  if (
    !message ||
    message["purpose"] !== "Project Inbox" ||
    message["dkim_verified"] !== true ||
    message["inbound_status"] === "Rejected" ||
    message["discarded_at"] !== null ||
    address?.["project_id"] !== projectId
  ) {
    throw refused("REFUSE", SOURCE_INVALID, "aurora_draft_source_invalid");
  }
  return {
    id,
    projectId,
    subject: typeof message["subject_line"] === "string" ? message["subject_line"] : null,
    body: typeof message["body_text"] === "string" ? message["body_text"] : "",
  };
}

/** A Proposed payable invoice the caller can read, whose lines Aurora reads (invoice_lines). */
export async function readProposedInvoice(
  context: RequestContext,
  id: string,
): Promise<{ id: string; currencyCode: string }> {
  const invoice = (
    await run<Row[]>(
      from(context.db, "invoices")
        .select("id, direction, invoice_state, currency_code")
        .eq("id", id)
        .is("deleted_at", null),
    )
  )[0];
  if (!invoice) throw notFound("The invoice is not visible to you.");
  if (invoice["direction"] !== "Payable" || invoice["invoice_state"] !== "Proposed") {
    throw refused(
      "REFUSE",
      "Aurora reads lines only into a Proposed payable invoice.",
      "aurora_invoice_not_proposed",
    );
  }
  return { id, currencyCode: String(invoice["currency_code"]) };
}

/** A proposed field's value, or null when it is NO_ANSWER or absent. */
export function proposedValue(proposal: StoredProposal, path: string): unknown {
  const field = proposal.fields.find((f) => f.field_path === path);
  return field && field.refusal === undefined ? (field.value ?? null) : null;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

/** The segments an itinerary proposed, as `@xos/ai/itinerary` checks them. */
export function itineraryLines(proposals: readonly StoredProposal[]): ItineraryLine[] {
  return proposals.map((p) => ({
    passengerName: text(proposedValue(p, "passenger_name")),
    travelMode: text(proposedValue(p, "travel_mode")),
    serviceIdentifier: text(proposedValue(p, "service_identifier")),
    departsFrom: text(proposedValue(p, "departs_from")),
    departsLocal: text(proposedValue(p, "departs_local")),
    departsTimeZone: text(proposedValue(p, "departs_time_zone")),
    arrivesAtPlace: text(proposedValue(p, "arrives_at_place")),
    arrivesLocal: text(proposedValue(p, "arrives_local")),
    arrivesTimeZone: text(proposedValue(p, "arrives_time_zone")),
  }));
}

/** The English outline of each governance kind, used when the caller sends none. */
export const GOVERNANCE_OUTLINES: Readonly<Record<GovernanceKind, readonly string[]>> = {
  event_plan: [
    "Overview",
    "Schedule",
    "Site and Venue",
    "Staffing and Roles",
    "Safety and Risk",
    "Medical and Emergency",
    "Communications",
    "Permits and Approvals",
  ],
  event_brief: [
    "Purpose",
    "Key Facts",
    "Schedule Highlights",
    "Contacts by Role",
    "What Is Needed",
  ],
  approval_pack: [
    "Cover Letter",
    "Event Summary",
    "Permits Held and Pending",
    "Insurance",
    "Risk Summary",
    "Site Plan and Capacity",
    "Contacts",
  ],
  waste_plan: [
    "Waste Streams",
    "Bins and Placement",
    "Vendor Responsibilities",
    "Collection Schedule",
    "Diversion Targets",
    "Reporting",
  ],
};

/** The most cues and risks a governance draft reads, as P6's lists cap them. */
const MAX_CUES = 60;
const MAX_RISKS = 40;

export interface GovernanceItem {
  readonly collection: string;
  readonly id: string;
  readonly table: string;
  readonly data: Row;
}

/**
 * Everything a governance draft sends, read with the caller's permissions through the in-process
 * API: the project, the cues of its running orders (at most 60), its Risk records (at most 40),
 * for an approval pack its Permit records and insurance certificates, for a waste plan its catering
 * fulfillments and project vendors (the vendors of its purchase orders and its live Vendor
 * engagements), each record once. `aurora.draft` and `aurora.preview` share it, so the panel lists
 * exactly what is sent.
 */
/** Insurance certificates an approval pack sends at most, all of them the project vendors'. */
const MAX_CERTIFICATES = 20;

export async function governanceItems(
  api: PublicApi,
  specs: readonly ResourceSpec[],
  kind: GovernanceKind,
  projectId: string,
): Promise<GovernanceItem[]> {
  const out: GovernanceItem[] = [];
  const add = (collection: string, data: unknown) => {
    const spec = specs.find((s) => s.path === `/${collection}`);
    if (!spec || typeof data !== "object" || data === null) return;
    const id = (data as Row)["id"];
    if (typeof id !== "string" || out.some((r) => r.collection === collection && r.id === id))
      return;
    out.push({ collection, id, table: spec.def.table, data: data as Row });
  };
  const list = async (collection: string, query: Record<string, string>, limit: number) => {
    const response = await api.get(`/${collection}`, { ...query, limit: String(limit) });
    const rows = (response.body as { data?: unknown } | null)?.data;
    return response.status === 200 && Array.isArray(rows) ? (rows as Row[]) : [];
  };
  const project = await api.get(`/projects/${projectId}`, {});
  if (project.status !== 200) return out;
  add("projects", project.body);
  let cues = 0;
  for (const running of await list("run-of-show", { "filter[project_id][eq]": projectId }, 10)) {
    add("run-of-show", running);
    for (const cue of await list(
      "cues",
      { "filter[run_of_show_id][eq]": String(running["id"]) },
      MAX_CUES - cues,
    )) {
      if (cues >= MAX_CUES) break;
      add("cues", cue);
      cues += 1;
    }
    if (cues >= MAX_CUES) break;
  }
  for (const risk of await list(
    "records",
    { "filter[project_id][eq]": projectId, "filter[record_kind][eq]": "Risk" },
    MAX_RISKS,
  )) {
    add("records", risk);
  }
  // Project vendors (correction 29): the vendors of the project's purchase orders and of its live Vendor
  // engagements' counterparties. The approval pack sends only their insurance certificates, since a certificate
  // belongs to a vendor and not to a project.
  const vendorIds = new Set<string>();
  const vendorEngagements: Row[] = [];
  if (kind === "approval_pack" || kind === "waste_plan") {
    for (const order of await list(
      "purchase-orders",
      { "filter[project_id][eq]": projectId },
      50,
    )) {
      if (typeof order["vendor_id"] === "string") vendorIds.add(order["vendor_id"]);
    }
    for (const engagement of await list(
      "engagements",
      { "filter[project_id][eq]": projectId, "filter[role_type][eq]": "Vendor" },
      20,
    )) {
      if (["Complete", "Canceled"].includes(String(engagement["engagement_state"]))) continue;
      vendorEngagements.push(engagement);
      if (typeof engagement["counterparty_id"] !== "string") continue;
      for (const vendor of await list(
        "vendors",
        { "filter[counterparty_id][eq]": engagement["counterparty_id"] },
        1,
      )) {
        if (typeof vendor["id"] === "string") vendorIds.add(vendor["id"]);
      }
    }
  }
  const vendors = [...vendorIds].slice(0, 20);
  if (kind === "approval_pack") {
    for (const permit of await list(
      "records",
      { "filter[project_id][eq]": projectId, "filter[record_kind][eq]": "Permit" },
      40,
    )) {
      add("records", permit);
    }
    let certificates = 0;
    for (const vendorId of vendors) {
      for (const certificate of await list(
        "insurance-certificates",
        { "filter[vendor_id][eq]": vendorId },
        MAX_CERTIFICATES - certificates,
      )) {
        add("insurance-certificates", certificate);
        certificates += 1;
      }
      if (certificates >= MAX_CERTIFICATES) break;
    }
  }
  if (kind === "waste_plan") {
    for (const catering of await list(
      "fulfillments",
      { "filter[project_id][eq]": projectId, "filter[fulfillment_kind][eq]": "Catering" },
      20,
    )) {
      add("fulfillments", catering);
    }
    for (const vendorId of vendors) {
      const vendor = await api.get(`/vendors/${vendorId}`, {});
      if (vendor.status === 200) add("vendors", vendor.body);
    }
    for (const engagement of vendorEngagements) add("engagements", engagement);
  }
  return out;
}
