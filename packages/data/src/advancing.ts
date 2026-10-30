import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DataError, type Result } from "./result.ts";
import type { Database } from "./database.types.ts";
import * as enums from "./enums.generated.ts";

/**
 * Advancing repository (Section 4.2): advance packets, their sections and party-bound recipients,
 * submissions and their review, riders and rider lines, and reconciliation of a project's
 * requirements against what venues and vendors provide. Reads and writes go through row level
 * security on the 0351 tables, so every function sees and changes exactly what the signed-in
 * person may (advancing.* capabilities under invariant 2).
 *
 * States shown for packets and rider lines are derived here from stored facts (sent_at, due_at,
 * submissions and reviews, fulfilled_at); nothing derived is ever written back (Section 3.15).
 */

// Shared --------------------------------------------------------------------------------------------

/** A refusal decided by this repository before the database is asked (same shape as XR001). */
function refuse<T>(rule: string, message: string): Result<T> {
  return fail({ kind: "refusal", rule, message });
}

const NOT_FOUND: DataError = { kind: "not-found" };

function byPosition<T extends { position: number }>(a: T, b: T): number {
  return a.position - b.position;
}

/** A project the viewer can advance in, for filters and create flows. */
export interface AdvancingProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** Projects of the org the viewer can see, in project key order. */
export async function listAdvancingProjects(
  db: XosClient,
  orgId: string,
): Promise<Result<AdvancingProject[]>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("project_key");
  if (error) return fail(toDataError(error));
  return ok(data.map((p) => ({ id: p.id, key: p.project_key, name: p.name })));
}

/** One project by its key; not-found when it does not exist or the viewer cannot see it. */
export async function getAdvancingProject(
  db: XosClient,
  orgId: string,
  projectKey: string,
): Promise<Result<AdvancingProject>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name")
    .eq("org_id", orgId)
    .eq("project_key", projectKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail(NOT_FOUND);
  return ok({ id: data.id, key: data.project_key, name: data.name });
}

/** A party an advance can go to or a rider can come from: a person or a counterparty. */
export interface AdvanceParty {
  readonly kind: "person" | "counterparty";
  readonly id: string;
  /** Null when the name is not visible to the viewer; the UI names the party kind instead. */
  readonly name: string | null;
  /** Canon counterparty type (Bible tab 28) for counterparties; null for people. */
  readonly counterpartyType: string | null;
}

/** People and counterparties the viewer can address, people first, each sorted by name. */
export async function listAdvanceParties(
  db: XosClient,
  orgId: string,
): Promise<Result<AdvanceParty[]>> {
  const [people, counterparties] = await Promise.all([
    db.from("people").select("id, full_name").is("deleted_at", null),
    db
      .from("counterparties")
      .select("id, counterparty_type, counterparty_name")
      .eq("org_id", orgId)
      .is("deleted_at", null),
  ]);
  if (people.error) return fail(toDataError(people.error));
  if (counterparties.error) return fail(toDataError(counterparties.error));
  const byName = (a: AdvanceParty, b: AdvanceParty) => (a.name ?? "").localeCompare(b.name ?? "");
  return ok([
    ...people.data
      .map((p): AdvanceParty => ({
        kind: "person",
        id: p.id,
        name: p.full_name,
        counterpartyType: null,
      }))
      .sort(byName),
    ...counterparties.data
      .map((c): AdvanceParty => ({
        kind: "counterparty",
        id: c.id,
        name: c.counterparty_name,
        counterpartyType: c.counterparty_type,
      }))
      .sort(byName),
  ]);
}

async function partyNames(
  db: XosClient,
  personIds: readonly string[],
  counterpartyIds: readonly string[],
): Promise<Result<Map<string, string | null>>> {
  const names = new Map<string, string | null>();
  if (personIds.length > 0) {
    const { data, error } = await db
      .from("people")
      .select("id, full_name")
      .in("id", [...new Set(personIds)]);
    if (error) return fail(toDataError(error));
    for (const p of data) names.set(p.id, p.full_name);
  }
  if (counterpartyIds.length > 0) {
    const { data, error } = await db
      .from("counterparties")
      .select("id, counterparty_name")
      .in("id", [...new Set(counterpartyIds)]);
    if (error) return fail(toDataError(error));
    for (const c of data) names.set(c.id, c.counterparty_name);
  }
  return ok(names);
}

/** The person each engagement names, for riders that belong to an individual artist's engagement. */
async function engagementPeople(
  db: XosClient,
  engagementIds: readonly string[],
): Promise<Result<Map<string, string>>> {
  const people = new Map<string, string>();
  if (engagementIds.length === 0) return ok(people);
  const { data, error } = await db
    .from("engagements")
    .select("id, person_id")
    .in("id", [...new Set(engagementIds)]);
  if (error) return fail(toDataError(error));
  for (const e of data) if (e.person_id) people.set(e.id, e.person_id);
  return ok(people);
}

// Packets -------------------------------------------------------------------------------------------

/**
 * Where a packet stands, derived from stored facts:
 * - Draft: not sent yet.
 * - Awaiting: sent, and some recipient has not answered some section.
 * - Overdue: Awaiting past its due time.
 * - InReview: every recipient answered every section, and some answer is not reviewed.
 * - Complete: every answer is reviewed.
 */
export const PACKET_STATES = ["Draft", "Awaiting", "Overdue", "InReview", "Complete"] as const;
export type PacketState = (typeof PACKET_STATES)[number];

export interface PacketProgress {
  /** Section and recipient pairs the packet asks for. */
  readonly expected: number;
  /** Pairs whose latest answer is not Returned. */
  readonly answered: number;
  /** Pairs whose latest answer is Accepted. */
  readonly reviewed: number;
}

export interface PacketSummary {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
  readonly sectionCount: number;
  readonly recipientCount: number;
  readonly progress: PacketProgress;
  readonly state: PacketState;
}

/** Outcome of reviewing an answer (app.advance_review_outcome). */
export type ReviewOutcome = Database["app"]["Enums"]["advance_review_outcome"];

interface SubmissionFact {
  readonly sectionId: string;
  readonly recipientId: string;
  readonly submittedAt: string;
  readonly reviewOutcome: ReviewOutcome | null;
}

/** The latest submission per section and recipient pair. */
function latestByPair<T extends SubmissionFact>(submissions: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const s of submissions) {
    const key = `${s.sectionId}:${s.recipientId}`;
    const current = latest.get(key);
    if (!current || current.submittedAt < s.submittedAt) latest.set(key, s);
  }
  return latest;
}

/** Progress of a packet over its live sections and recipients. */
export function packetProgress(
  sectionIds: readonly string[],
  recipientIds: readonly string[],
  submissions: readonly SubmissionFact[],
): PacketProgress {
  const sections = new Set(sectionIds);
  const recipients = new Set(recipientIds);
  const latest = latestByPair(
    submissions.filter((s) => sections.has(s.sectionId) && recipients.has(s.recipientId)),
  );
  let answered = 0;
  let reviewed = 0;
  for (const s of latest.values()) {
    // A returned answer asks the recipient to answer again, so the pair counts as open.
    if (s.reviewOutcome !== "Returned") answered += 1;
    if (s.reviewOutcome === "Accepted") reviewed += 1;
  }
  return { expected: sections.size * recipients.size, answered, reviewed };
}

/** The derived packet state (see PACKET_STATES). */
export function packetState(
  packet: { readonly sentAt: string | null; readonly dueAt: string | null },
  progress: PacketProgress,
  now: Date,
): PacketState {
  if (packet.sentAt === null) return "Draft";
  const allAnswered = progress.expected > 0 && progress.answered >= progress.expected;
  if (!allAnswered) {
    return packet.dueAt !== null && new Date(packet.dueAt) < now ? "Overdue" : "Awaiting";
  }
  return progress.reviewed >= progress.expected ? "Complete" : "InReview";
}

/** Packets of the org, or of one project, newest first, with derived progress and state. */
export async function listPackets(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string },
  now: Date = new Date(),
): Promise<Result<PacketSummary[]>> {
  let query = db
    .from("advance_packets")
    .select("id, project_id, title, due_at, sent_at, created_at")
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId !== undefined) query = query.eq("project_id", filter.projectId);
  const { data: packets, error } = await query.order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  if (packets.length === 0) return ok([]);
  const ids = packets.map((p) => p.id);
  const [sections, recipients] = await Promise.all([
    db
      .from("advance_sections")
      .select("id, advance_packet_id")
      .in("advance_packet_id", ids)
      .is("deleted_at", null),
    db
      .from("advance_recipients")
      .select("id, advance_packet_id")
      .in("advance_packet_id", ids)
      .is("deleted_at", null),
  ]);
  if (sections.error) return fail(toDataError(sections.error));
  if (recipients.error) return fail(toDataError(recipients.error));
  const sectionIds = sections.data.map((s) => s.id);
  const fetched = await fetchSubmissions(db, sectionIds);
  if (!fetched.ok) return fail(fetched.error);
  const submissions: SubmissionFact[] = fetched.data;
  return ok(
    packets.map((p): PacketSummary => {
      const packetSections = sections.data.filter((s) => s.advance_packet_id === p.id);
      const packetRecipients = recipients.data.filter((r) => r.advance_packet_id === p.id);
      const progress = packetProgress(
        packetSections.map((s) => s.id),
        packetRecipients.map((r) => r.id),
        submissions,
      );
      const facts = { sentAt: p.sent_at, dueAt: p.due_at };
      return {
        id: p.id,
        projectId: p.project_id,
        title: p.title,
        dueAt: p.due_at,
        sentAt: p.sent_at,
        createdAt: p.created_at,
        sectionCount: packetSections.length,
        recipientCount: packetRecipients.length,
        progress,
        state: packetState(facts, progress, now),
      };
    }),
  );
}

export interface AdvanceSection {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string | null;
}

export interface AdvanceRecipient {
  readonly id: string;
  readonly party: AdvanceParty;
}

export interface AdvanceSubmission {
  readonly id: string;
  readonly sectionId: string;
  readonly recipientId: string;
  readonly body: string;
  readonly submittedAt: string;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly reviewOutcome: ReviewOutcome | null;
  readonly returnReason: string | null;
  /** True when the recipient answered through a Gateway advance link. */
  readonly viaLink: boolean;
  /** True for the newest submission of its section and recipient pair. */
  readonly latest: boolean;
}

interface SubmissionRow {
  id: string;
  advance_section_id: string;
  advance_recipient_id: string;
  body: string;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_outcome: ReviewOutcome | null;
  return_reason: string | null;
  advance_recipient_token_id: string | null;
}

/** Live submissions to the given sections, newest first. */
async function fetchSubmissions(
  db: XosClient,
  sectionIds: readonly string[],
): Promise<Result<Omit<AdvanceSubmission, "latest">[]>> {
  if (sectionIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("advance_submissions")
    .select(
      "id, advance_section_id, advance_recipient_id, body, submitted_at, reviewed_at, reviewed_by, review_outcome, return_reason, advance_recipient_token_id",
    )
    .in("advance_section_id", sectionIds)
    .is("deleted_at", null)
    .order("submitted_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((s: SubmissionRow) => ({
      id: s.id,
      sectionId: s.advance_section_id,
      recipientId: s.advance_recipient_id,
      body: s.body,
      submittedAt: s.submitted_at,
      reviewedAt: s.reviewed_at,
      reviewedBy: s.reviewed_by,
      reviewOutcome: s.review_outcome,
      returnReason: s.return_reason,
      viaLink: s.advance_recipient_token_id !== null,
    })),
  );
}

export interface PacketDetail extends PacketSummary {
  readonly sections: readonly AdvanceSection[];
  readonly recipients: readonly AdvanceRecipient[];
  readonly submissions: readonly AdvanceSubmission[];
}

/** One packet with its sections in order, its recipients and every submission. */
export async function getPacket(
  db: XosClient,
  packetId: string,
  now: Date = new Date(),
): Promise<Result<PacketDetail>> {
  const { data: packet, error } = await db
    .from("advance_packets")
    .select("id, project_id, title, due_at, sent_at, created_at")
    .eq("id", packetId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!packet) return fail(NOT_FOUND);
  const [sections, recipients] = await Promise.all([
    db
      .from("advance_sections")
      .select("id, position, title, prompt")
      .eq("advance_packet_id", packetId)
      .is("deleted_at", null)
      .order("position"),
    db
      .from("advance_recipients")
      .select("id, person_id, counterparty_id")
      .eq("advance_packet_id", packetId)
      .is("deleted_at", null)
      .order("created_at"),
  ]);
  if (sections.error) return fail(toDataError(sections.error));
  if (recipients.error) return fail(toDataError(recipients.error));
  const names = await partyNames(
    db,
    recipients.data.flatMap((r) => (r.person_id ? [r.person_id] : [])),
    recipients.data.flatMap((r) => (r.counterparty_id ? [r.counterparty_id] : [])),
  );
  if (!names.ok) return fail(names.error);
  const fetched = await fetchSubmissions(
    db,
    sections.data.map((s) => s.id),
  );
  if (!fetched.ok) return fail(fetched.error);
  const rows = fetched.data;
  const latest = new Set([...latestByPair(rows).values()].map((s) => s.id));
  const submissions = rows.map((s) => ({ ...s, latest: latest.has(s.id) }));
  const recipientList = recipients.data.map((r): AdvanceRecipient => ({
    id: r.id,
    party: r.person_id
      ? {
          kind: "person",
          id: r.person_id,
          name: names.data.get(r.person_id) ?? null,
          counterpartyType: null,
        }
      : {
          kind: "counterparty",
          id: r.counterparty_id ?? "",
          name: names.data.get(r.counterparty_id ?? "") ?? null,
          counterpartyType: null,
        },
  }));
  const sectionList = sections.data
    .map((s): AdvanceSection => ({
      id: s.id,
      position: s.position,
      title: s.title,
      prompt: s.prompt,
    }))
    .sort(byPosition);
  const progress = packetProgress(
    sectionList.map((s) => s.id),
    recipientList.map((r) => r.id),
    submissions,
  );
  return ok({
    id: packet.id,
    projectId: packet.project_id,
    title: packet.title,
    dueAt: packet.due_at,
    sentAt: packet.sent_at,
    createdAt: packet.created_at,
    sectionCount: sectionList.length,
    recipientCount: recipientList.length,
    progress,
    state: packetState({ sentAt: packet.sent_at, dueAt: packet.due_at }, progress, now),
    sections: sectionList,
    recipients: recipientList,
    submissions,
  });
}

function cleanTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length >= 1 && trimmed.length <= 200 ? trimmed : null;
}

/** Creates a draft packet in a project; returns its id. */
export async function createPacket(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly title: string;
    readonly dueAt: string | null;
  },
): Promise<Result<{ id: string }>> {
  const title = cleanTitle(input.title);
  if (title === null) return fail({ kind: "invalid", message: "title" });
  const { data, error } = await db
    .from("advance_packets")
    .insert({ org_id: input.orgId, project_id: input.projectId, title, due_at: input.dueAt })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Renames a packet or changes when answers are due. */
export async function updatePacket(
  db: XosClient,
  packetId: string,
  input: { readonly title: string; readonly dueAt: string | null },
): Promise<Result<null>> {
  const title = cleanTitle(input.title);
  if (title === null) return fail({ kind: "invalid", message: "title" });
  const { data, error } = await db
    .from("advance_packets")
    .update({ title, due_at: input.dueAt })
    .eq("id", packetId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/** Moves a packet to the archive (soft delete). Its sections, recipients and answers are kept. */
export async function archivePacket(
  db: XosClient,
  packetId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("advance_packets")
    .update({ deleted_at: now.toISOString() })
    .eq("id", packetId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/**
 * Sends a draft packet through app.send_advance_packet, which needs advancing.packet.send and
 * refuses a packet already sent or one without sections or recipients.
 */
export async function sendPacket(
  db: XosClient,
  packetId: string,
): Promise<Result<{ sentAt: string }>> {
  const { data, error } = await db.rpc("send_advance_packet", { p_packet_id: packetId });
  if (error) return fail(toDataError(error));
  return ok({ sentAt: data });
}

// Advance links -------------------------------------------------------------------------------------

/** A Gateway advance link of a recipient; the token and code are never readable after issue. */
export interface AdvanceLink {
  readonly id: string;
  readonly recipientId: string;
  readonly recipientEmail: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
  readonly locked: boolean;
  readonly claimedAt: string | null;
  readonly createdAt: string;
}

/** Where a link stands for the person who issued it. */
export function linkStatus(
  link: AdvanceLink,
  now: Date = new Date(),
): "Live" | "Used" | "Expired" | "Revoked" | "Locked" {
  if (link.revokedAt !== null) return "Revoked";
  if (link.locked) return "Locked";
  if (new Date(link.expiresAt) <= now) return "Expired";
  return link.usedAt !== null ? "Used" : "Live";
}

interface LinkRow {
  id: string;
  advance_recipient_id: string;
  recipient_email: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  failed_attempts: number;
  claimed_at: string | null;
  created_at: string;
}

/** Links issued for the recipients of a packet, newest first. Needs advancing.packet.send. */
export async function listAdvanceLinks(
  db: XosClient,
  recipientIds: readonly string[],
): Promise<Result<AdvanceLink[]>> {
  if (recipientIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("advance_recipient_tokens")
    .select(
      "id, advance_recipient_id, recipient_email, expires_at, used_at, revoked_at, failed_attempts, claimed_at, created_at",
    )
    .in("advance_recipient_id", recipientIds)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((l: LinkRow) => ({
      id: l.id,
      recipientId: l.advance_recipient_id,
      recipientEmail: l.recipient_email,
      expiresAt: l.expires_at,
      usedAt: l.used_at,
      revokedAt: l.revoked_at,
      locked: l.failed_attempts >= 5,
      claimedAt: l.claimed_at,
      createdAt: l.created_at,
    })),
  );
}

/** A newly issued link: the token and access code are shown once and never stored in clear. */
export interface IssuedAdvanceLink {
  readonly id: string;
  readonly token: string;
  readonly accessCode: string;
  readonly expiresAt: string;
}

/** Issues a link for a recipient of a sent packet; earlier links of the recipient are revoked. */
export async function issueAdvanceLink(
  db: XosClient,
  input: { readonly recipientId: string; readonly email: string; readonly validDays: number },
): Promise<Result<IssuedAdvanceLink>> {
  if (!Number.isInteger(input.validDays) || input.validDays < 1 || input.validDays > 90) {
    return fail({ kind: "invalid", message: "validDays" });
  }
  const { data, error } = await db.rpc("issue_advance_token", {
    p_recipient_id: input.recipientId,
    p_recipient_email: input.email.trim(),
    p_valid_for: `${input.validDays} days`,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "unexpected", message: "issue_advance_token returned no row" });
  return ok({
    id: row.token_id,
    token: row.token,
    accessCode: row.access_code,
    expiresAt: row.expires_at,
  });
}

/** Revokes a link. */
export async function revokeAdvanceLink(db: XosClient, linkId: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_advance_token", { p_token_id: linkId });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Sections ------------------------------------------------------------------------------------------

/** Appends a section to a packet; returns its id. */
export async function addSection(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly packetId: string;
    readonly title: string;
    readonly prompt: string | null;
  },
): Promise<Result<{ id: string }>> {
  const title = cleanTitle(input.title);
  if (title === null) return fail({ kind: "invalid", message: "title" });
  const { data: last, error: readError } = await db
    .from("advance_sections")
    .select("position")
    .eq("advance_packet_id", input.packetId)
    .is("deleted_at", null)
    .order("position", { ascending: false })
    .limit(1);
  if (readError) return fail(toDataError(readError));
  const position = (last[0]?.position ?? 0) + 1;
  const prompt = input.prompt?.trim() ? input.prompt.trim() : null;
  const { data, error } = await db
    .from("advance_sections")
    .insert({
      org_id: input.orgId,
      advance_packet_id: input.packetId,
      position,
      title,
      prompt,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Changes a section's title or prompt. */
export async function updateSection(
  db: XosClient,
  sectionId: string,
  input: { readonly title: string; readonly prompt: string | null },
): Promise<Result<null>> {
  const title = cleanTitle(input.title);
  if (title === null) return fail({ kind: "invalid", message: "title" });
  const prompt = input.prompt?.trim() ? input.prompt.trim() : null;
  const { data, error } = await db
    .from("advance_sections")
    .update({ title, prompt })
    .eq("id", sectionId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/** Removes a section (soft delete); answers already given stay on record. */
export async function removeSection(
  db: XosClient,
  sectionId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("advance_sections")
    .update({ deleted_at: now.toISOString() })
    .eq("id", sectionId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/**
 * Moves a section one place up or down. Positions are unique among live sections, so the swap
 * parks the moving section past the end first.
 */
export async function moveSection(
  db: XosClient,
  input: {
    readonly packetId: string;
    readonly sectionId: string;
    readonly direction: "up" | "down";
  },
): Promise<Result<null>> {
  const { data: rows, error } = await db
    .from("advance_sections")
    .select("id, position")
    .eq("advance_packet_id", input.packetId)
    .is("deleted_at", null)
    .order("position");
  if (error) return fail(toDataError(error));
  const sections = [...rows].sort(byPosition);
  const index = sections.findIndex((s) => s.id === input.sectionId);
  if (index < 0) return fail(NOT_FOUND);
  const other = sections[input.direction === "up" ? index - 1 : index + 1];
  const moving = sections[index];
  if (!other || !moving) return ok(null);
  const parked = (sections.at(-1)?.position ?? 0) + 1;
  for (const [id, position] of [
    [moving.id, parked],
    [other.id, moving.position],
    [moving.id, other.position],
  ] as const) {
    const step = await db.from("advance_sections").update({ position }).eq("id", id);
    if (step.error) return fail(toDataError(step.error));
  }
  return ok(null);
}

// Recipients ----------------------------------------------------------------------------------------

/** Adds a person or counterparty as a recipient; adding the same party twice is refused. */
export async function addRecipient(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly packetId: string;
    readonly party: { readonly kind: "person" | "counterparty"; readonly id: string };
  },
): Promise<Result<{ id: string }>> {
  const column = input.party.kind === "person" ? "person_id" : "counterparty_id";
  const { data: existing, error: readError } = await db
    .from("advance_recipients")
    .select("id")
    .eq("advance_packet_id", input.packetId)
    .eq(column, input.party.id)
    .is("deleted_at", null);
  if (readError) return fail(toDataError(readError));
  if (existing.length > 0) {
    return refuse("advance_recipient_duplicate", "This party already receives the packet.");
  }
  const { data, error } = await db
    .from("advance_recipients")
    .insert({
      org_id: input.orgId,
      advance_packet_id: input.packetId,
      person_id: input.party.kind === "person" ? input.party.id : null,
      counterparty_id: input.party.kind === "counterparty" ? input.party.id : null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a recipient (soft delete); their answers stay on record. */
export async function removeRecipient(
  db: XosClient,
  recipientId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("advance_recipients")
    .update({ deleted_at: now.toISOString() })
    .eq("id", recipientId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

// Submissions ---------------------------------------------------------------------------------------

export type SubmissionFilter = "unreviewed" | "reviewed" | "all";

export interface SubmissionListItem extends AdvanceSubmission {
  readonly packetId: string;
  readonly packetTitle: string;
  readonly projectId: string;
  readonly sectionTitle: string;
  readonly sectionPrompt: string | null;
  readonly recipient: AdvanceParty;
}

/** Submissions across packets, newest first; reviewers work the unreviewed latest answers. */
export async function listSubmissions(
  db: XosClient,
  filter: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly review?: SubmissionFilter;
  },
): Promise<Result<SubmissionListItem[]>> {
  let packetQuery = db
    .from("advance_packets")
    .select("id, project_id, title")
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId !== undefined) packetQuery = packetQuery.eq("project_id", filter.projectId);
  const { data: packets, error } = await packetQuery;
  if (error) return fail(toDataError(error));
  if (packets.length === 0) return ok([]);
  const packetIds = packets.map((p) => p.id);
  const [sections, recipients] = await Promise.all([
    db
      .from("advance_sections")
      .select("id, advance_packet_id, title, prompt")
      .in("advance_packet_id", packetIds)
      .is("deleted_at", null),
    db
      .from("advance_recipients")
      .select("id, person_id, counterparty_id")
      .in("advance_packet_id", packetIds),
  ]);
  if (sections.error) return fail(toDataError(sections.error));
  if (recipients.error) return fail(toDataError(recipients.error));
  if (sections.data.length === 0) return ok([]);
  const fetched = await fetchSubmissions(
    db,
    sections.data.map((s) => s.id),
  );
  if (!fetched.ok) return fail(fetched.error);
  const names = await partyNames(
    db,
    recipients.data.flatMap((r) => (r.person_id ? [r.person_id] : [])),
    recipients.data.flatMap((r) => (r.counterparty_id ? [r.counterparty_id] : [])),
  );
  if (!names.ok) return fail(names.error);
  const rows = fetched.data;
  const latest = new Set([...latestByPair(rows).values()].map((s) => s.id));
  const sectionById = new Map(sections.data.map((s) => [s.id, s]));
  const packetById = new Map(packets.map((p) => [p.id, p]));
  const recipientById = new Map(recipients.data.map((r) => [r.id, r]));
  const items = rows.flatMap((s): SubmissionListItem[] => {
    const section = sectionById.get(s.sectionId);
    const packet = section ? packetById.get(section.advance_packet_id) : undefined;
    const recipient = recipientById.get(s.recipientId);
    if (!section || !packet || !recipient) return [];
    const partyId = recipient.person_id ?? recipient.counterparty_id ?? "";
    return [
      {
        ...s,
        latest: latest.has(s.id),
        packetId: packet.id,
        packetTitle: packet.title,
        projectId: packet.project_id,
        sectionTitle: section.title,
        sectionPrompt: section.prompt,
        recipient: {
          kind: recipient.person_id ? "person" : "counterparty",
          id: partyId,
          name: names.data.get(partyId) ?? null,
          counterpartyType: null,
        },
      },
    ];
  });
  switch (filter.review ?? "all") {
    case "unreviewed":
      return ok(items.filter((s) => s.latest && s.reviewedAt === null));
    case "reviewed":
      return ok(items.filter((s) => s.reviewedAt !== null));
    default:
      return ok(items);
  }
}

/**
 * Records an answer on a recipient's behalf, for example one given by phone. Recipients answer
 * through the Gateway advance form themselves. Only a sent packet takes answers.
 */
export async function recordSubmission(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly sectionId: string;
    readonly recipientId: string;
    readonly body: string;
  },
): Promise<Result<{ id: string }>> {
  const body = input.body.trim();
  if (body.length === 0) return fail({ kind: "invalid", message: "body" });
  const { data: section, error: readError } = await db
    .from("advance_sections")
    .select("id, advance_packet_id, packet:advance_packets!inner(sent_at)")
    .eq("id", input.sectionId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) return fail(toDataError(readError));
  if (!section) return fail(NOT_FOUND);
  if (section.packet.sent_at === null) {
    return refuse("advance_packet_unsent", "Send the packet before recording answers.");
  }
  const { data, error } = await db
    .from("advance_submissions")
    .insert({
      org_id: input.orgId,
      advance_section_id: input.sectionId,
      advance_recipient_id: input.recipientId,
      body,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/**
 * Reviews an answer once: Accepted, or Returned to the recipient with a reason to answer again.
 * The database stamps the reviewer and the time, and refuses the person who submitted the answer
 * (sod_advance_submitter).
 */
export async function reviewSubmission(
  db: XosClient,
  input: {
    readonly submissionId: string;
    readonly reviewerPersonId: string;
    readonly outcome: ReviewOutcome;
    readonly returnReason?: string | null;
  },
  now: Date = new Date(),
): Promise<Result<{ reviewedAt: string }>> {
  const reason = input.returnReason?.trim() ?? "";
  if (input.outcome === "Returned" && (reason.length === 0 || reason.length > 1000)) {
    return fail({ kind: "invalid", message: "returnReason" });
  }
  const reviewedAt = now.toISOString();
  const { data, error } = await db
    .from("advance_submissions")
    .update({
      reviewed_at: reviewedAt,
      reviewed_by: input.reviewerPersonId,
      review_outcome: input.outcome,
      return_reason: input.outcome === "Returned" ? reason : null,
    })
    .eq("id", input.submissionId)
    .is("reviewed_at", null)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) {
    return refuse("advance_submission_reviewed", "This answer was already reviewed.");
  }
  return ok({ reviewedAt });
}

// Riders --------------------------------------------------------------------------------------------

export interface RiderSummary {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly counterpartyId: string | null;
  readonly counterpartyName: string | null;
  /** Artist engagement whose rider it is, for an artist booked as a person (R2); never set with a counterparty. */
  readonly engagementId: string | null;
  /** Name of the engagement's artist; null when not visible to the viewer. */
  readonly engagementName: string | null;
  readonly createdAt: string;
  readonly lineCount: number;
  readonly fulfilledCount: number;
}

export interface RiderLine {
  readonly id: string;
  readonly description: string;
  readonly elementId: string | null;
  readonly quantity: number | null;
  readonly fulfilledAt: string | null;
}

export interface RiderDetail extends RiderSummary {
  readonly lines: readonly RiderLine[];
}

/** Riders of the org or one project, newest first, with open and fulfilled line counts. */
export async function listRiders(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<RiderSummary[]>> {
  let query = db
    .from("riders")
    .select("id, project_id, title, counterparty_id, engagement_id, created_at")
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId !== undefined) query = query.eq("project_id", filter.projectId);
  const { data: riders, error } = await query.order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  if (riders.length === 0) return ok([]);
  const { data: lines, error: lineError } = await db
    .from("rider_lines")
    .select("rider_id, fulfilled_at")
    .in(
      "rider_id",
      riders.map((r) => r.id),
    )
    .is("deleted_at", null);
  if (lineError) return fail(toDataError(lineError));
  const artists = await engagementPeople(
    db,
    riders.flatMap((r) => (r.engagement_id ? [r.engagement_id] : [])),
  );
  if (!artists.ok) return fail(artists.error);
  const names = await partyNames(
    db,
    [...artists.data.values()],
    riders.flatMap((r) => (r.counterparty_id ? [r.counterparty_id] : [])),
  );
  if (!names.ok) return fail(names.error);
  return ok(
    riders.map((r): RiderSummary => {
      const own = lines.filter((l) => l.rider_id === r.id);
      const artist = r.engagement_id ? artists.data.get(r.engagement_id) : undefined;
      return {
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        counterpartyId: r.counterparty_id,
        counterpartyName: r.counterparty_id ? (names.data.get(r.counterparty_id) ?? null) : null,
        engagementId: r.engagement_id,
        engagementName: artist ? (names.data.get(artist) ?? null) : null,
        createdAt: r.created_at,
        lineCount: own.length,
        fulfilledCount: own.filter((l) => l.fulfilled_at !== null).length,
      };
    }),
  );
}

/** One rider with its lines in the order they were recorded. */
export async function getRider(db: XosClient, riderId: string): Promise<Result<RiderDetail>> {
  const { data: rider, error } = await db
    .from("riders")
    .select("id, project_id, title, counterparty_id, engagement_id, created_at")
    .eq("id", riderId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!rider) return fail(NOT_FOUND);
  const { data: lines, error: lineError } = await db
    .from("rider_lines")
    .select("id, description, element_id, quantity, fulfilled_at")
    .eq("rider_id", riderId)
    .is("deleted_at", null)
    .order("created_at");
  if (lineError) return fail(toDataError(lineError));
  const artists = await engagementPeople(db, rider.engagement_id ? [rider.engagement_id] : []);
  if (!artists.ok) return fail(artists.error);
  const artist = rider.engagement_id ? artists.data.get(rider.engagement_id) : undefined;
  const names = await partyNames(
    db,
    artist ? [artist] : [],
    rider.counterparty_id ? [rider.counterparty_id] : [],
  );
  if (!names.ok) return fail(names.error);
  return ok({
    id: rider.id,
    projectId: rider.project_id,
    title: rider.title,
    counterpartyId: rider.counterparty_id,
    counterpartyName: rider.counterparty_id
      ? (names.data.get(rider.counterparty_id) ?? null)
      : null,
    engagementId: rider.engagement_id,
    engagementName: artist ? (names.data.get(artist) ?? null) : null,
    createdAt: rider.created_at,
    lineCount: lines.length,
    fulfilledCount: lines.filter((l) => l.fulfilled_at !== null).length,
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      elementId: l.element_id,
      quantity: l.quantity,
      fulfilledAt: l.fulfilled_at,
    })),
  });
}

/**
 * Records a rider received from a party, a counterparty or an individual artist's engagement (at most
 * one); returns its id.
 */
export async function createRider(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly title: string;
    readonly counterpartyId: string | null;
    readonly engagementId: string | null;
  },
): Promise<Result<{ id: string }>> {
  const title = cleanTitle(input.title);
  if (title === null) return fail({ kind: "invalid", message: "title" });
  if (input.counterpartyId !== null && input.engagementId !== null)
    return fail({ kind: "invalid", message: "party" });
  const { data, error } = await db
    .from("riders")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      title,
      counterparty_id: input.counterpartyId,
      engagement_id: input.engagementId,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Renames a rider or changes whose rider it is: a counterparty, an artist's engagement, or nobody. */
export async function updateRider(
  db: XosClient,
  riderId: string,
  input: {
    readonly title: string;
    readonly counterpartyId: string | null;
    readonly engagementId: string | null;
  },
): Promise<Result<null>> {
  const title = cleanTitle(input.title);
  if (title === null) return fail({ kind: "invalid", message: "title" });
  if (input.counterpartyId !== null && input.engagementId !== null)
    return fail({ kind: "invalid", message: "party" });
  const { data, error } = await db
    .from("riders")
    .update({ title, counterparty_id: input.counterpartyId, engagement_id: input.engagementId })
    .eq("id", riderId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/** Moves a rider to the archive (soft delete). */
export async function archiveRider(
  db: XosClient,
  riderId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("riders")
    .update({ deleted_at: now.toISOString() })
    .eq("id", riderId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

export interface RiderLineInput {
  readonly description: string;
  readonly elementId: string | null;
  /** Null when the ask is not countable; never coerced to zero. */
  readonly quantity: number | null;
}

function cleanLine(input: RiderLineInput): RiderLineInput | null {
  const description = input.description.trim();
  if (description.length === 0 || description.length > 500) return null;
  if (input.quantity !== null && (!Number.isFinite(input.quantity) || input.quantity < 0)) {
    return null;
  }
  const elementId = input.elementId?.trim() ? input.elementId.trim() : null;
  return { description, elementId, quantity: input.quantity };
}

/** Adds one ask to a rider; returns its id. */
export async function addRiderLine(
  db: XosClient,
  input: { readonly orgId: string; readonly riderId: string; readonly line: RiderLineInput },
): Promise<Result<{ id: string }>> {
  const line = cleanLine(input.line);
  if (line === null) return fail({ kind: "invalid", message: "line" });
  const { data, error } = await db
    .from("rider_lines")
    .insert({
      org_id: input.orgId,
      rider_id: input.riderId,
      description: line.description,
      element_id: line.elementId,
      quantity: line.quantity,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Changes an ask's description, element or quantity. */
export async function updateRiderLine(
  db: XosClient,
  lineId: string,
  input: RiderLineInput,
): Promise<Result<null>> {
  const line = cleanLine(input);
  if (line === null) return fail({ kind: "invalid", message: "line" });
  const { data, error } = await db
    .from("rider_lines")
    .update({
      description: line.description,
      element_id: line.elementId,
      quantity: line.quantity,
    })
    .eq("id", lineId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/** Marks an ask fulfilled now, or reopens it. */
export async function setRiderLineFulfilled(
  db: XosClient,
  lineId: string,
  fulfilled: boolean,
  now: Date = new Date(),
): Promise<Result<{ fulfilledAt: string | null }>> {
  const fulfilledAt = fulfilled ? now.toISOString() : null;
  const { data, error } = await db
    .from("rider_lines")
    .update({ fulfilled_at: fulfilledAt })
    .eq("id", lineId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok({ fulfilledAt });
}

/** Removes an ask from a rider (soft delete). */
export async function removeRiderLine(
  db: XosClient,
  lineId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("rider_lines")
    .update({ deleted_at: now.toISOString() })
    .eq("id", lineId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/**
 * The rider extraction hook (A25, Aurora AI). An extractor reads a rider document and proposes
 * lines with a confidence per line; nothing is saved until a person confirms. This repository
 * never calls an AI service: it only stores the lines a person confirmed.
 */
export interface RiderLineProposal extends RiderLineInput {
  /** Extractor confidence from 0 to 1, shown to the person who confirms. */
  readonly confidence: number;
  /** The passage of the source document the line was read from. */
  readonly source: string | null;
}

export interface RiderExtractor {
  /** Proposes lines for a rider document; must not write anything. */
  readonly propose: (input: {
    readonly riderId: string;
    readonly documentText: string;
  }) => Promise<Result<readonly RiderLineProposal[]>>;
}

/** Stores the proposals a person confirmed as rider lines, in the given order. */
export async function confirmRiderLineProposals(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly riderId: string;
    readonly proposals: readonly RiderLineProposal[];
  },
): Promise<Result<{ ids: string[] }>> {
  const lines = input.proposals.map((p) =>
    cleanLine({ description: p.description, elementId: p.elementId, quantity: p.quantity }),
  );
  if (lines.length === 0) return ok({ ids: [] });
  if (lines.some((l) => l === null)) return fail({ kind: "invalid", message: "line" });
  const { data, error } = await db
    .from("rider_lines")
    .insert(
      lines.flatMap((l) =>
        l
          ? [
              {
                org_id: input.orgId,
                rider_id: input.riderId,
                description: l.description,
                element_id: l.elementId,
                quantity: l.quantity,
              },
            ]
          : [],
      ),
    )
    .select("id");
  if (error) return fail(toDataError(error));
  return ok({ ids: data.map((d) => d.id) });
}

// Reconciliation ------------------------------------------------------------------------------------

export type ReconciliationResult = Database["app"]["Enums"]["reconciliation_result"];

/** A requirement or capability statement of a project (one table, a direction facet). */
export interface CapabilityStatement {
  readonly id: string;
  readonly direction: Database["app"]["Enums"]["capability_direction"];
  readonly urid: string;
  readonly description: string;
  readonly quantity: number | null;
  readonly unitBasis: string | null;
  readonly isCritical: boolean;
  /** Capability assertion word (Bible tab 22): CERTIFIED, DOCUMENTED, CLAIMED, INFERRED, UNKNOWN. */
  readonly assertionWord: string;
  readonly venueId: string | null;
  readonly counterpartyId: string | null;
}

/** Live requirements and capabilities of a project, in URID order. */
export async function listCapabilityStatements(
  db: XosClient,
  projectId: string,
): Promise<Result<CapabilityStatement[]>> {
  const { data, error } = await db
    .from("capability_statements")
    .select(
      "id, direction, urid, description, quantity, unit_basis, is_critical, assertion_word, venue_id, counterparty_id",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("urid");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((s) => ({
      id: s.id,
      direction: s.direction,
      urid: s.urid,
      description: s.description,
      quantity: s.quantity,
      unitBasis: s.unit_basis,
      isCritical: s.is_critical,
      assertionWord: s.assertion_word,
      venueId: s.venue_id,
      counterpartyId: s.counterparty_id,
    })),
  );
}

export interface ReconciliationSummary {
  readonly id: string;
  readonly projectId: string;
  readonly reconciledAt: string;
  readonly note: string | null;
  readonly met: number;
  readonly gap: number;
  readonly unknown: number;
  /** Gaps plus Unknowns against critical requirements: what gate 3 reads (G3.NO_CRITICAL_GAPS). */
  readonly gate3Gaps: number;
}

/** Reconciliation runs of the org or one project, newest first, with result counts. */
export async function listReconciliations(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<ReconciliationSummary[]>> {
  let query = db
    .from("reconciliations")
    .select("id, project_id, reconciled_at, note")
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId !== undefined) query = query.eq("project_id", filter.projectId);
  const { data: runs, error } = await query.order("reconciled_at", { ascending: false });
  if (error) return fail(toDataError(error));
  if (runs.length === 0) return ok([]);
  const ids = runs.map((r) => r.id);
  const [lines, gaps] = await Promise.all([
    db
      .from("reconciliation_lines")
      .select("reconciliation_id, result")
      .in("reconciliation_id", ids)
      .is("deleted_at", null),
    db
      .from("reconciliation_gaps")
      .select("reconciliation_id, result, is_critical")
      .in("reconciliation_id", ids),
  ]);
  if (lines.error) return fail(toDataError(lines.error));
  if (gaps.error) return fail(toDataError(gaps.error));
  return ok(
    runs.map((r): ReconciliationSummary => {
      const own = lines.data.filter((l) => l.reconciliation_id === r.id);
      return {
        id: r.id,
        projectId: r.project_id,
        reconciledAt: r.reconciled_at,
        note: r.note,
        met: own.filter((l) => l.result === "Met").length,
        gap: own.filter((l) => l.result === "Gap").length,
        unknown: own.filter((l) => l.result === "Unknown").length,
        gate3Gaps: gaps.data.filter((g) => g.reconciliation_id === r.id).length,
      };
    }),
  );
}

export interface ReconciliationLineDetail {
  readonly id: string;
  readonly result: ReconciliationResult;
  readonly requirement: CapabilityStatement;
  readonly capability: CapabilityStatement | null;
  /** True when this line is a gate 3 gap: a Gap, or an Unknown against a critical requirement. */
  readonly gate3Gap: boolean;
}

export interface ReconciliationDetail extends ReconciliationSummary {
  readonly lines: readonly ReconciliationLineDetail[];
}

/** One reconciliation with its lines, requirements in URID order. */
export async function getReconciliation(
  db: XosClient,
  reconciliationId: string,
): Promise<Result<ReconciliationDetail>> {
  const { data: run, error } = await db
    .from("reconciliations")
    .select("id, project_id, reconciled_at, note")
    .eq("id", reconciliationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!run) return fail(NOT_FOUND);
  const { data: lines, error: lineError } = await db
    .from("reconciliation_lines")
    .select("id, requirement_id, capability_id, result")
    .eq("reconciliation_id", reconciliationId)
    .is("deleted_at", null);
  if (lineError) return fail(toDataError(lineError));
  const statements = await listCapabilityStatements(db, run.project_id);
  if (!statements.ok) return fail(statements.error);
  const byId = new Map(statements.data.map((s) => [s.id, s]));
  const detail = lines
    .flatMap((l): ReconciliationLineDetail[] => {
      const requirement = byId.get(l.requirement_id);
      if (!requirement) return [];
      return [
        {
          id: l.id,
          result: l.result,
          requirement,
          capability: l.capability_id ? (byId.get(l.capability_id) ?? null) : null,
          gate3Gap: l.result === "Gap" || (l.result === "Unknown" && requirement.isCritical),
        },
      ];
    })
    .sort((a, b) => a.requirement.urid.localeCompare(b.requirement.urid, "en", { numeric: true }));
  return ok({
    id: run.id,
    projectId: run.project_id,
    reconciledAt: run.reconciled_at,
    note: run.note,
    met: detail.filter((l) => l.result === "Met").length,
    gap: detail.filter((l) => l.result === "Gap").length,
    unknown: detail.filter((l) => l.result === "Unknown").length,
    gate3Gaps: detail.filter((l) => l.gate3Gap).length,
    lines: detail,
  });
}

/**
 * Runs a reconciliation of a project through A09's app.reconcile_project (migration 0420), which
 * applies the silence rule with the canon assertion ranks: no claim, or an UNKNOWN claim, is
 * Unknown and never Met. A project without requirements is refused first, because an empty run
 * would read as nothing missing.
 */
export async function runReconciliation(
  db: XosClient,
  input: { readonly projectId: string; readonly note: string | null },
): Promise<Result<{ id: string }>> {
  const statements = await listCapabilityStatements(db, input.projectId);
  if (!statements.ok) return fail(statements.error);
  if (!statements.data.some((s) => s.direction === "Require")) {
    return refuse("reconciliation_no_requirements", "Add requirements before reconciling.");
  }
  const note = input.note?.trim() ? input.note.trim() : null;
  const { data, error } = await db.rpc("reconcile_project", {
    p_project_id: input.projectId,
    ...(note === null ? {} : { p_note: note }),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

// Guest list ----------------------------------------------------------------------------------------

/** Guest list states (app.guest_entry_state, migration 0431), in lifecycle order. */
export const GUEST_STATES = enums.guestEntryState;
export type GuestState = (typeof GUEST_STATES)[number];

export interface GuestEntry {
  readonly id: string;
  readonly projectId: string;
  readonly scopeNodeId: string | null;
  /** The party whose list the guest is on; null for guests the production adds itself. */
  readonly party: AdvanceParty | null;
  /** Set when an engaged party requested the guest in Gateway. */
  readonly engagementId: string | null;
  readonly guestName: string;
  readonly plusOnes: number;
  readonly note: string | null;
  readonly state: GuestState;
  readonly decidedAt: string | null;
  readonly checkedInAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

/** A show or other scope node a guest can attend. */
export interface ScopeOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** Scope nodes of a project in code order, for the show a guest attends. */
export async function listProjectScopes(
  db: XosClient,
  projectId: string,
): Promise<Result<ScopeOption[]>> {
  const { data, error } = await db
    .from("scope_nodes")
    .select("id, scope_code, name")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("scope_code");
  if (error) return fail(toDataError(error));
  return ok(data.map((n) => ({ id: n.id, code: n.scope_code, name: n.name })));
}

/** The guest list of the org or one project, oldest request first, optionally in one state. */
export async function listGuests(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string; readonly state?: GuestState },
): Promise<Result<GuestEntry[]>> {
  let query = db
    .from("guest_list_entries")
    .select(
      "id, project_id, scope_node_id, person_id, counterparty_id, engagement_id, guest_name, plus_ones, note, entry_state, decided_at, checked_in_at, created_at, created_by",
    )
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId !== undefined) query = query.eq("project_id", filter.projectId);
  if (filter.state !== undefined) query = query.eq("entry_state", filter.state);
  const { data, error } = await query.order("created_at");
  if (error) return fail(toDataError(error));
  const names = await partyNames(
    db,
    data.flatMap((g) => (g.person_id ? [g.person_id] : [])),
    data.flatMap((g) => (g.counterparty_id ? [g.counterparty_id] : [])),
  );
  if (!names.ok) return fail(names.error);
  const party = (personId: string | null, counterpartyId: string | null): AdvanceParty | null => {
    if (personId) {
      return {
        kind: "person",
        id: personId,
        name: names.data.get(personId) ?? null,
        counterpartyType: null,
      };
    }
    if (counterpartyId) {
      return {
        kind: "counterparty",
        id: counterpartyId,
        name: names.data.get(counterpartyId) ?? null,
        counterpartyType: null,
      };
    }
    return null;
  };
  return ok(
    data.map((g): GuestEntry => ({
      id: g.id,
      projectId: g.project_id,
      scopeNodeId: g.scope_node_id,
      party: party(g.person_id, g.counterparty_id),
      engagementId: g.engagement_id,
      guestName: g.guest_name,
      plusOnes: g.plus_ones,
      note: g.note,
      state: g.entry_state,
      decidedAt: g.decided_at,
      checkedInAt: g.checked_in_at,
      createdAt: g.created_at,
      createdBy: g.created_by,
    })),
  );
}

export interface GuestInput {
  readonly guestName: string;
  /** Additional guests admitted with this one, 0 to 20. */
  readonly plusOnes: number;
  readonly note: string | null;
  readonly scopeNodeId: string | null;
}

function cleanGuest(input: GuestInput): GuestInput | null {
  const guestName = input.guestName.trim();
  if (guestName.length === 0 || guestName.length > 200) return null;
  if (!Number.isInteger(input.plusOnes) || input.plusOnes < 0 || input.plusOnes > 20) return null;
  const note = input.note?.trim() ? input.note.trim() : null;
  if (note !== null && note.length > 500) return null;
  return { guestName, plusOnes: input.plusOnes, note, scopeNodeId: input.scopeNodeId };
}

/**
 * Adds a guest to a project's list as Requested, or as Approved when `approve` is set (a reviewer
 * adding a comp; the database checks review authority and stamps the decision).
 */
export async function addGuest(
  db: XosClient,
  input: GuestInput & {
    readonly orgId: string;
    readonly projectId: string;
    readonly approve?: boolean;
  },
): Promise<Result<{ id: string }>> {
  const guest = cleanGuest(input);
  if (guest === null) return fail({ kind: "invalid", message: "guest" });
  const { data, error } = await db
    .from("guest_list_entries")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      scope_node_id: guest.scopeNodeId,
      guest_name: guest.guestName,
      plus_ones: guest.plusOnes,
      note: guest.note,
      entry_state: input.approve === true ? "Approved" : "Requested",
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Changes a requested guest; a decided guest keeps its guest (0431 guard). */
export async function updateGuest(
  db: XosClient,
  guestId: string,
  input: GuestInput,
): Promise<Result<null>> {
  const guest = cleanGuest(input);
  if (guest === null) return fail({ kind: "invalid", message: "guest" });
  const { data, error } = await db
    .from("guest_list_entries")
    .update({
      guest_name: guest.guestName,
      plus_ones: guest.plusOnes,
      note: guest.note,
      scope_node_id: guest.scopeNodeId,
    })
    .eq("id", guestId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

async function moveGuest(
  db: XosClient,
  guestId: string,
  from: GuestState,
  to: GuestState,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("guest_list_entries")
    .update({ entry_state: to })
    .eq("id", guestId)
    .eq("entry_state", from)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) {
    return refuse("guest_entry_moved", "Someone already changed this guest. Refresh the list.");
  }
  return ok(null);
}

/** Approves or declines a requested guest; the requester cannot decide (sod_guest_requester). */
export function decideGuest(
  db: XosClient,
  guestId: string,
  outcome: "Approved" | "Declined",
): Promise<Result<null>> {
  return moveGuest(db, guestId, "Requested", outcome);
}

/** Checks an approved guest in at the door. */
export function checkInGuest(db: XosClient, guestId: string): Promise<Result<null>> {
  return moveGuest(db, guestId, "Approved", "Checked In");
}

/** Removes a guest from the list (soft delete). */
export async function removeGuest(
  db: XosClient,
  guestId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("guest_list_entries")
    .update({ deleted_at: now.toISOString() })
    .eq("id", guestId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}
