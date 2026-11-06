/**
 * What B15's Aurora handlers read before any model call (RRR-239, ADR 0154), kept beside
 * handlers/parts/aurora.ts, which wires them into the operations. Everything runs in the caller's
 * session, and every refusal comes before app.ai_begin_request, so a refused request is never metered.
 */
import type { GovernanceKind, PublicApi } from "@xos/ai";
import type { ResourceSpec } from "../../catalog/types.ts";
import { notFound, refused } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { from, run, type Row } from "../support/table.ts";

export interface InboxMessage {
  readonly id: string;
  readonly fromAddress: string;
  readonly body: string;
}

/**
 * A project inbox message a draft may read. Row level security decides what is readable
 * (knowledge.document.write). Purpose Reply and anything not Verified or Filed refuses
 * aurora_advance_source_unverified, since a spoofed sender must never feed an answer; another
 * project's mail is not found, and a blank body refuses aurora_advance_source_empty.
 */
export async function readInboxMessage(
  context: RequestContext,
  id: string,
  projectId: string,
): Promise<InboxMessage> {
  const message = (
    await run<Row[]>(
      from(context.db, "inbound_messages")
        .select("id, purpose, inbound_status, discarded_at, from_address, body_text, inbound_address_id")
        .eq("id", id)
        .is("deleted_at", null),
    )
  )[0];
  if (!message) throw notFound("The message is not visible to you.");
  const unverified = () =>
    refused(
      "REFUSE",
      "Aurora drafts only from verified mail in this project's inbox.",
      "aurora_advance_source_unverified",
    );
  if (message["purpose"] !== "Project Inbox") throw unverified();
  const address = (
    await run<Row[]>(
      from(context.db, "inbound_addresses")
        .select("project_id")
        .eq("id", String(message["inbound_address_id"])),
    )
  )[0];
  if (address?.["project_id"] !== projectId) throw notFound("The message is not in this inbox.");
  if (
    !["Verified", "Filed"].includes(String(message["inbound_status"])) ||
    message["discarded_at"] !== null
  ) {
    throw unverified();
  }
  const body = typeof message["body_text"] === "string" ? message["body_text"] : "";
  if (body.trim() === "") {
    throw refused(
      "REFUSE",
      "This message has no text to read. Choose a file instead.",
      "aurora_advance_source_empty",
    );
  }
  return { id, fromAddress: String(message["from_address"]), body };
}

/** The Document subtype each governance kind is written into (canon, 0150). */
export const GOVERNANCE_SUBTYPE: Readonly<Record<GovernanceKind, string>> = {
  event_plan: "Plan",
  waste_plan: "Plan",
  event_brief: "Brief",
  approval_pack: "Package",
};

export interface GovernanceItem {
  readonly collection: string;
  readonly id: string;
  readonly table: string;
  readonly data: Row;
}

/**
 * The Document record a governance draft fills: refused when absent or of another collection, kind
 * or subtype, and not found when the caller cannot read it. Its project comes back, for the scope.
 */
export async function governanceTarget(
  api: PublicApi,
  kind: GovernanceKind,
  target: { collection: string; id: string } | undefined,
): Promise<{ id: string; projectId: string }> {
  if (!target) {
    throw refused(
      "REFUSE",
      "Name the Document record to draft into.",
      "aurora_draft_target_required",
    );
  }
  const mismatch = () =>
    refused(
      "REFUSE",
      `This draft goes into a Document record of subtype ${GOVERNANCE_SUBTYPE[kind]}.`,
      "aurora_draft_target_mismatch",
    );
  if (target.collection !== "records") throw mismatch();
  const response = await api.get(`/records/${target.id}`, {});
  if (response.status !== 200) throw notFound("The record is not visible to you.");
  const record = response.body as Row;
  if (record["record_kind"] !== "Document" || record["record_subtype"] !== GOVERNANCE_SUBTYPE[kind]) {
    throw mismatch();
  }
  return { id: target.id, projectId: String(record["project_id"]) };
}

/**
 * Everything a governance draft sends, read as the caller through the in-process API: the record, its
 * project, up to 10 Event records and up to 20 named context records; for an approval pack the
 * project's gate readiness; for a waste plan its objectives and measurements. `aurora.draft` and
 * `aurora.preview` share it, so the panel lists exactly what is sent.
 */
export async function governanceDraftItems(
  api: PublicApi,
  specs: readonly ResourceSpec[],
  kind: GovernanceKind,
  target: { id: string; projectId: string },
  context: readonly { collection: string; id: string }[],
): Promise<GovernanceItem[]> {
  const out: GovernanceItem[] = [];
  const add = (collection: string, data: unknown) => {
    const spec = specs.find((s) => s.path === `/${collection}`);
    if (!spec || typeof data !== "object" || data === null) return;
    const id = (data as Row)["id"];
    if (typeof id !== "string" || out.some((r) => r.collection === collection && r.id === id)) {
      return;
    }
    out.push({ collection, id, table: spec.def.table, data: data as Row });
  };
  const read = async (collection: string, id: string) => {
    const response = await api.get(`/${collection}/${id}`, {});
    if (response.status === 200) add(collection, response.body);
  };
  const list = async (collection: string, query: Record<string, string>) => {
    const response = await api.get(`/${collection}`, query);
    const rows = (response.body as { data?: unknown } | null)?.data;
    if (response.status === 200 && Array.isArray(rows)) {
      for (const row of rows) add(collection, row);
    }
  };
  await read("records", target.id);
  await read("projects", target.projectId);
  await list("records", {
    "filter[project_id][eq]": target.projectId,
    "filter[record_kind][eq]": "Event",
    limit: "10",
  });
  for (const item of context.slice(0, 20)) await read(item.collection, item.id);
  if (kind === "approval_pack") {
    const readiness = await api.get(`/projects/${target.projectId}/gate-readiness`, {});
    const rows = (readiness.body as { data?: unknown } | null)?.data;
    if (readiness.status === 200 && Array.isArray(rows)) {
      out.push({
        collection: "projects",
        id: target.projectId,
        table: "app.gate_criteria_status",
        data: { gate_readiness: rows as unknown[] },
      });
    }
  }
  if (kind === "waste_plan") {
    const scoped = { "filter[project_id][eq]": target.projectId, limit: "50" };
    await list("project-objectives", scoped);
    await list("project-measurements", scoped);
  }
  return out;
}
