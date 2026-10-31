import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

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
export type ReviewOutcome = "Accepted" | "Returned";

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

/** What a section asks for (app.advance_section_kind, R9). */
export const ADVANCE_SECTION_KINDS = [
  "Text",
  "File",
  "Schedule Window",
  "Item Request",
  "Crew Roster",
  "Guest List",
  "Credential Request",
] as const;
export type AdvanceSectionKind = (typeof ADVANCE_SECTION_KINDS)[number];

/** What a Schedule Window section asks the time of (app.advance_window_kind, R9). */
export const ADVANCE_WINDOW_KINDS = [
  "Load In",
  "Load Out",
  "Arrival",
  "Soundcheck",
  "Activation Setup",
  "Activation Strike",
] as const;
export type AdvanceWindowKind = (typeof ADVANCE_WINDOW_KINDS)[number];

/** The most lines each kind lets an answer hold, as advance_sections_kind_fields checks it. */
export const SECTION_LINE_LIMITS: Readonly<Partial<Record<AdvanceSectionKind, number>>> = {
  File: 10,
  "Schedule Window": 5,
  "Item Request": 50,
  "Credential Request": 50,
};

/** How a section is configured beyond its title and prompt (R9). */
export interface SectionConfig {
  readonly kind: AdvanceSectionKind;
  readonly windowKind: AdvanceWindowKind | null;
  readonly maxLines: number | null;
  readonly perPerson: boolean;
}

/** An asset class an Item Request offers, or a credential category a Credential Request offers. */
export interface SectionChoice {
  readonly id: string;
  readonly assetClassId: string | null;
  readonly credentialCategoryId: string | null;
  readonly name: string;
}

export interface AdvanceSection extends SectionConfig {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string | null;
  readonly choices: readonly SectionChoice[];
}

export interface AdvanceRecipient {
  readonly id: string;
  readonly party: AdvanceParty;
  /** Engagement the recipient answers under (R9); null for token recipients and venues. */
  readonly engagementId: string | null;
  /** When the party stops naming people on the passes it requested (G-141); null without one. */
  readonly namesDueAt: string | null;
  /** True once namesDueAt has passed, as of the read. */
  readonly namesClosed: boolean;
}

/** The section configuration a kind allows, or null when the input does not fit the kind. */
export function sectionConfig(input: {
  readonly kind: AdvanceSectionKind;
  readonly windowKind?: AdvanceWindowKind | null;
  readonly maxLines?: number | null;
  readonly perPerson?: boolean;
}): SectionConfig | null {
  const limit = SECTION_LINE_LIMITS[input.kind];
  if (limit === undefined)
    return { kind: input.kind, windowKind: null, maxLines: null, perPerson: false };
  const maxLines = input.maxLines ?? null;
  if (maxLines === null || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > limit)
    return null;
  if (input.kind === "Schedule Window") {
    if (!input.windowKind) return null;
    return { kind: input.kind, windowKind: input.windowKind, maxLines, perPerson: false };
  }
  const perPerson =
    input.kind === "Item Request" || input.kind === "Credential Request"
      ? input.perPerson === true
      : false;
  return { kind: input.kind, windowKind: null, maxLines, perPerson };
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
  /** The recipient's note on a typed answer (R9). */
  readonly note: string | null;
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
  note: string | null;
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
      "id, advance_section_id, advance_recipient_id, body, submitted_at, reviewed_at, reviewed_by, review_outcome, return_reason, advance_recipient_token_id, note",
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
      note: s.note,
    })),
  );
}

/** Live choices of the given sections, by section, each named by its class or category. */
async function sectionChoices(
  db: XosClient,
  sectionIds: readonly string[],
): Promise<Result<Map<string, SectionChoice[]>>> {
  const bySection = new Map<string, SectionChoice[]>();
  if (sectionIds.length === 0) return ok(bySection);
  const { data, error } = await db
    .from("advance_section_choices")
    .select(
      "id, advance_section_id, asset_class_id, credential_category_id, asset_class:asset_classes(name), category:credential_categories(name)",
    )
    .in("advance_section_id", [...sectionIds])
    .is("deleted_at", null)
    .order("created_at");
  if (error) return fail(toDataError(error));
  for (const c of data) {
    const list = bySection.get(c.advance_section_id) ?? [];
    list.push({
      id: c.id,
      assetClassId: c.asset_class_id,
      credentialCategoryId: c.credential_category_id,
      name: c.asset_class?.name ?? c.category?.name ?? "",
    });
    bySection.set(c.advance_section_id, list);
  }
  return ok(bySection);
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
      .select("id, position, title, prompt, section_kind, window_kind, max_lines, per_person")
      .eq("advance_packet_id", packetId)
      .is("deleted_at", null)
      .order("position"),
    db
      .from("advance_recipients")
      .select("id, person_id, counterparty_id, engagement_id, names_due_at")
      .eq("advance_packet_id", packetId)
      .is("deleted_at", null)
      .order("created_at"),
  ]);
  if (sections.error) return fail(toDataError(sections.error));
  if (recipients.error) return fail(toDataError(recipients.error));
  const choices = await sectionChoices(
    db,
    sections.data.map((s) => s.id),
  );
  if (!choices.ok) return fail(choices.error);
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
    engagementId: r.engagement_id,
    namesDueAt: r.names_due_at,
    namesClosed: r.names_due_at !== null && new Date(r.names_due_at).getTime() <= now.getTime(),
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
      kind: s.section_kind,
      windowKind: s.window_kind,
      maxLines: s.max_lines,
      perPerson: s.per_person,
      choices: choices.data.get(s.id) ?? [],
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
    /** The kind and its configuration (R9); Text when left out. */
    readonly config?: SectionConfig;
  },
): Promise<Result<{ id: string }>> {
  const title = cleanTitle(input.title);
  if (title === null) return fail({ kind: "invalid", message: "title" });
  const config = input.config ?? {
    kind: "Text",
    windowKind: null,
    maxLines: null,
    perPerson: false,
  };
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
      section_kind: config.kind,
      window_kind: config.windowKind,
      max_lines: config.maxLines,
      per_person: config.perPerson,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Changes a draft section's kind and configuration (fixed once the packet is sent). */
export async function configureSection(
  db: XosClient,
  sectionId: string,
  config: SectionConfig,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("advance_sections")
    .update({
      section_kind: config.kind,
      window_kind: config.windowKind,
      max_lines: config.maxLines,
      per_person: config.perPerson,
    })
    .eq("id", sectionId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/** Offers an asset class (Item Request) or a credential category (Credential Request) in a section. */
export async function addSectionChoice(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly sectionId: string;
    readonly target: { readonly kind: "asset_class" | "credential_category"; readonly id: string };
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("advance_section_choices")
    .insert({
      org_id: input.orgId,
      advance_section_id: input.sectionId,
      asset_class_id: input.target.kind === "asset_class" ? input.target.id : null,
      credential_category_id: input.target.kind === "credential_category" ? input.target.id : null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a choice from a draft section (soft delete). */
export async function removeSectionChoice(
  db: XosClient,
  choiceId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("advance_section_choices")
    .update({ deleted_at: now.toISOString() })
    .eq("id", choiceId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/** What a project's sections can offer: asset classes that answer for an offering, and credential categories. */
export interface SectionChoiceOptions {
  readonly assetClasses: readonly { id: string; name: string; offering: string }[];
  readonly credentialCategories: readonly { id: string; name: string; kind: string }[];
}

export async function listSectionChoiceOptions(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId: string },
): Promise<Result<SectionChoiceOptions>> {
  const [classes, categories] = await Promise.all([
    db
      .from("asset_classes")
      .select("id, name, offering")
      .eq("org_id", input.orgId)
      .not("offering", "is", null)
      .is("deleted_at", null)
      .order("name"),
    db
      .from("credential_categories")
      .select("id, name, category_kind")
      .eq("project_id", input.projectId)
      .is("deleted_at", null)
      .order("name"),
  ]);
  if (classes.error) return fail(toDataError(classes.error));
  if (categories.error) return fail(toDataError(categories.error));
  return ok({
    assetClasses: classes.data.flatMap((c) =>
      c.offering ? [{ id: c.id, name: c.name, offering: c.offering }] : [],
    ),
    credentialCategories: categories.data.map((k) => ({
      id: k.id,
      name: k.name,
      kind: k.category_kind,
    })),
  });
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
    /** The engagement the recipient answers under (R9). */
    readonly engagementId?: string | null;
    /** When the party stops naming people on requested passes (G-141); needs an engagement. */
    readonly namesDueAt?: string | null;
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
      engagement_id: input.engagementId ?? null,
      names_due_at: input.engagementId ? (input.namesDueAt ?? null) : null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Links a draft recipient to the engagement it answers under (fixed once the packet is sent). */
export async function bindRecipientEngagement(
  db: XosClient,
  recipientId: string,
  engagementId: string | null,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("advance_recipients")
    .update({ engagement_id: engagementId })
    .eq("id", recipientId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/**
 * Sets or clears a recipient's naming deadline (G-141, migration 2716). It stays editable after
 * the packet is sent; a recipient without an engagement takes none.
 */
export async function setRecipientNamesDue(
  db: XosClient,
  recipientId: string,
  namesDueAt: string | null,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("advance_recipients")
    .update({ names_due_at: namesDueAt })
    .eq("id", recipientId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail(NOT_FOUND) : ok(null);
}

/** Live engagements of a project with their party, for linking recipients. */
export interface ProjectEngagement {
  readonly id: string;
  readonly personId: string | null;
  readonly counterpartyId: string | null;
  readonly roleType: string;
  readonly name: string | null;
}

export async function listProjectEngagements(
  db: XosClient,
  projectId: string,
): Promise<Result<ProjectEngagement[]>> {
  const { data, error } = await db
    .from("engagements")
    .select("id, person_id, counterparty_id, role_type, engagement_state")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .not("engagement_state", "in", "(Complete,Canceled)")
    .order("created_at");
  if (error) return fail(toDataError(error));
  const names = await partyNames(
    db,
    data.flatMap((e) => (e.person_id ? [e.person_id] : [])),
    data.flatMap((e) => (e.counterparty_id ? [e.counterparty_id] : [])),
  );
  if (!names.ok) return fail(names.error);
  return ok(
    data.map((e) => ({
      id: e.id,
      personId: e.person_id,
      counterpartyId: e.counterparty_id,
      roleType: e.role_type,
      name: names.data.get(e.counterparty_id ?? "") ?? names.data.get(e.person_id ?? "") ?? null,
    })),
  );
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
  /** The section's kind and window kind (R9). */
  readonly sectionKind: AdvanceSectionKind;
  readonly windowKind: AdvanceWindowKind | null;
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
      .select("id, advance_packet_id, title, prompt, section_kind, window_kind")
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
        sectionKind: section.section_kind,
        windowKind: section.window_kind,
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

// Typed answer details (R9, migrations 2711 and 2712) ------------------------------------------------

/** One line of a typed answer as a reviewer reads it. */
export interface AnswerLine {
  readonly id: string;
  readonly submissionId: string;
  readonly lineNumber: number;
  /** The class or category name; null on a window line. */
  readonly itemName: string | null;
  readonly quantity: number | null;
  readonly rosterEntryId: string | null;
  readonly personName: string | null;
  readonly neededFrom: string | null;
  readonly neededTo: string | null;
  readonly windowZone: string | null;
  readonly note: string | null;
  readonly allocationId: string | null;
  /** The allocation's computed stage (app.advance_allocation_status), e.g. Requested or Reserved. */
  readonly allocationStatus: string | null;
  /** Named people on a credential pool line: the live Requested or Approved shares split from it (G-141). */
  readonly namedQuantity: number | null;
  /** The pool's quantity now, for "Named n of q" (G-141). */
  readonly poolQuantity: number | null;
  /** The dock slot booked from a Load In or Load Out window. */
  readonly dockSlotId: string | null;
}

/** One file of a File answer, with the version Atlas serves at /files/party/<version>. */
export interface AnswerFile {
  readonly id: string;
  readonly submissionId: string;
  readonly position: number;
  readonly title: string;
  readonly versionId: string | null;
}

/** The parsed bounds of a Postgres tstzrange literal such as ["2027-06-01 08:00:00+00","…"). */
export function windowBounds(range: string | null): { from: string | null; to: string | null } {
  if (!range) return { from: null, to: null };
  const match = /^[[(]"?([^",]*)"?,"?([^")]*)"?[)\]]$/.exec(range);
  if (!match) return { from: null, to: null };
  // Postgres writes "2027-06-01 08:00:00+00"; Date wants a T and a full offset.
  const iso = (v: string | undefined) =>
    v ? new Date(v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString() : null;
  return { from: iso(match[1]), to: iso(match[2]) };
}

/** Lines and files of the given answers, in order, with each line's allocation stage. */
export async function listAnswerDetails(
  db: XosClient,
  submissionIds: readonly string[],
): Promise<Result<{ lines: AnswerLine[]; files: AnswerFile[] }>> {
  if (submissionIds.length === 0) return ok({ lines: [], files: [] });
  const ids = [...new Set(submissionIds)];
  const [lines, files] = await Promise.all([
    db
      .from("advance_submission_lines")
      .select(
        "id, advance_submission_id, line_number, asset_class_id, credential_category_id, roster_entry_id, quantity, needed_window, window_zone, note, asset_class:asset_classes(name), category:credential_categories(name)",
      )
      .in("advance_submission_id", ids)
      .order("line_number"),
    db
      .from("advance_submission_files")
      .select(
        "id, advance_submission_id, position, document:documents(title, versions:document_versions(id, version_number))",
      )
      .in("advance_submission_id", ids)
      .order("position"),
  ]);
  if (lines.error) return fail(toDataError(lines.error));
  if (files.error) return fail(toDataError(files.error));
  const lineIds = lines.data.map((l) => l.id);
  const entryIds = lines.data.flatMap((l) => (l.roster_entry_id ? [l.roster_entry_id] : []));
  const [allocations, slots, entries] = await Promise.all([
    lineIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("advance_allocations")
          .select("id, advance_submission_line_id, quantity")
          .in("advance_submission_line_id", lineIds),
    lineIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("dock_slots")
          .select("id, advance_submission_line_id")
          .in("advance_submission_line_id", lineIds)
          .is("deleted_at", null),
    entryIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("engagement_roster_entries")
          .select("id, person_id, is_self, engagement:engagements(person_id)")
          .in("id", entryIds),
  ]);
  if (allocations.error) return fail(toDataError(allocations.error));
  if (slots.error) return fail(toDataError(slots.error));
  if (entries.error) return fail(toDataError(entries.error));
  const allocationIds = allocations.data.map((a) => a.id);
  const [status, shares] = await Promise.all([
    allocationIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("advance_allocation_status")
          .select("allocation_id, display_status")
          .in("allocation_id", allocationIds),
    allocationIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("advance_allocations")
          .select("parent_allocation_id, quantity")
          .in("parent_allocation_id", allocationIds)
          .in("allocation_state", ["Requested", "Approved"])
          .is("deleted_at", null),
  ]);
  if (status.error) return fail(toDataError(status.error));
  if (shares.error) return fail(toDataError(shares.error));
  const personByEntry = new Map(
    entries.data.map((e) => [
      e.id,
      e.person_id ?? (e.is_self ? (e.engagement?.person_id ?? null) : null),
    ]),
  );
  const names = await partyNames(
    db,
    [...personByEntry.values()].flatMap((p) => (p ? [p] : [])),
    [],
  );
  if (!names.ok) return fail(names.error);
  const allocationByLine = new Map(
    allocations.data.map((a) => [a.advance_submission_line_id ?? "", a]),
  );
  const statusById = new Map(status.data.map((r) => [r.allocation_id ?? "", r.display_status]));
  const named = new Map<string, number>();
  for (const share of shares.data) {
    const key = share.parent_allocation_id ?? "";
    named.set(key, (named.get(key) ?? 0) + Number(share.quantity));
  }
  const slotByLine = new Map(slots.data.map((d) => [d.advance_submission_line_id ?? "", d.id]));
  return ok({
    lines: lines.data.map((l): AnswerLine => {
      const window = windowBounds(l.needed_window as string | null);
      const allocation = allocationByLine.get(l.id);
      const person = l.roster_entry_id ? (personByEntry.get(l.roster_entry_id) ?? null) : null;
      const isPool =
        allocation !== undefined && l.credential_category_id !== null && l.roster_entry_id === null;
      return {
        id: l.id,
        submissionId: l.advance_submission_id,
        lineNumber: l.line_number,
        itemName: l.asset_class?.name ?? l.category?.name ?? null,
        quantity: l.quantity,
        rosterEntryId: l.roster_entry_id,
        personName: person ? (names.data.get(person) ?? null) : null,
        neededFrom: window.from,
        neededTo: window.to,
        windowZone: l.window_zone,
        note: l.note,
        allocationId: allocation?.id ?? null,
        allocationStatus: allocation ? (statusById.get(allocation.id) ?? null) : null,
        namedQuantity: isPool ? (named.get(allocation.id) ?? 0) : null,
        poolQuantity: isPool ? Number(allocation.quantity) + (named.get(allocation.id) ?? 0) : null,
        dockSlotId: slotByLine.get(l.id) ?? null,
      };
    }),
    files: files.data.map((f): AnswerFile => {
      const versions = [...(f.document?.versions ?? [])].sort(
        (a, b) => b.version_number - a.version_number,
      );
      return {
        id: f.id,
        submissionId: f.advance_submission_id,
        position: f.position,
        title: f.document?.title ?? "",
        versionId: versions[0]?.id ?? null,
      };
    }),
  });
}

/**
 * Books an Accepted Load In or Load Out window as a dock slot of the recipient's engagement
 * (app.book_dock_slot_from_answer); needs logistics.dock_slot.write.
 */
export async function bookDockSlotFromAnswer(
  db: XosClient,
  input: { readonly lineId: string; readonly zoneId: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("book_dock_slot_from_answer", {
    p_line_id: input.lineId,
    p_zone_id: input.zoneId,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Zones of the project's venue, for booking a dock slot. */
export async function listProjectZones(
  db: XosClient,
  projectId: string,
): Promise<Result<{ id: string; code: string; name: string }[]>> {
  const { data: project, error } = await db
    .from("projects")
    .select("venue_id")
    .eq("id", projectId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!project?.venue_id) return ok([]);
  const zones = await db
    .from("zones")
    .select("id, code, name")
    .eq("venue_id", project.venue_id)
    .is("deleted_at", null)
    .order("code");
  if (zones.error) return fail(toDataError(zones.error));
  return ok(zones.data);
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

export type ReconciliationResult = "Met" | "Gap" | "Unknown";

/** A requirement or capability statement of a project (one table, a direction facet). */
export interface CapabilityStatement {
  readonly id: string;
  readonly direction: "Require" | "Provide";
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
export const GUEST_STATES = ["Requested", "Approved", "Declined", "Checked In"] as const;
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
  /** The pass (B8, 2974): an Access category of the project, set by the production. */
  readonly passCategoryId: string | null;
  readonly tableLabel: string | null;
  readonly hostPersonId: string | null;
  /** Confidential; where the guest's pass and messages go. */
  readonly guestEmail: string | null;
  /** Stamped by the database on approval; printed as XOSGP1:<code>. */
  readonly passCode: string | null;
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

/** A guest list row as listGuests reads it; the pass columns (2974) are newer than the generated types. */
interface GuestRow {
  id: string;
  project_id: string;
  scope_node_id: string | null;
  person_id: string | null;
  counterparty_id: string | null;
  engagement_id: string | null;
  guest_name: string;
  plus_ones: number;
  note: string | null;
  entry_state: GuestState;
  decided_at: string | null;
  checked_in_at: string | null;
  created_at: string;
  created_by: string | null;
  pass_category_id: string | null;
  table_label: string | null;
  host_person_id: string | null;
  guest_email: string | null;
  pass_code: string | null;
}

/** The guest list of the org or one project, oldest request first, optionally in one state. */
export async function listGuests(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string; readonly state?: GuestState },
): Promise<Result<GuestEntry[]>> {
  let query = untyped(db)
    .from("guest_list_entries")
    .select(
      "id, project_id, scope_node_id, person_id, counterparty_id, engagement_id, guest_name, plus_ones, note, entry_state, decided_at, checked_in_at, created_at, created_by, pass_category_id, table_label, host_person_id, guest_email, pass_code",
    )
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId !== undefined) query = query.eq("project_id", filter.projectId);
  if (filter.state !== undefined) query = query.eq("entry_state", filter.state);
  const { data: raw, error } = await query.order("created_at");
  if (error) return fail(toDataError(error));
  const data = (raw ?? []) as GuestRow[];
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
      passCategoryId: g.pass_category_id,
      tableLabel: g.table_label,
      hostPersonId: g.host_person_id,
      guestEmail: g.guest_email,
      passCode: g.pass_code,
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
    /** The pass fields (B8, 2974), set by the production with the guest. */
    readonly pass?: GuestPassInput;
  },
): Promise<Result<{ id: string }>> {
  const guest = cleanGuest(input);
  if (guest === null) return fail({ kind: "invalid", message: "guest" });
  const pass = input.pass ? cleanGuestPass(input.pass) : null;
  if (pass === undefined) return fail({ kind: "invalid", message: "guest_pass" });
  const { data, error } = await untyped(db)
    .from("guest_list_entries")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      scope_node_id: guest.scopeNodeId,
      guest_name: guest.guestName,
      plus_ones: guest.plusOnes,
      note: guest.note,
      entry_state: input.approve === true ? "Approved" : "Requested",
      ...(pass
        ? {
            pass_category_id: pass.passCategoryId,
            table_label: pass.tableLabel,
            host_person_id: pass.hostPersonId,
            guest_email: pass.guestEmail,
          }
        : {}),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
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

/** A guest's pass fields (B8, 2974), set by the production in any state but Checked In. */
export interface GuestPassInput {
  readonly passCategoryId: string | null;
  readonly tableLabel: string | null;
  readonly hostPersonId: string | null;
  readonly guestEmail: string | null;
}

/** The pattern and length app.guest_list_entries_guest_email checks (1382's address rule). */
export function cleanGuestEmail(value: string | null | undefined): string | null | undefined {
  const email = (value ?? "").trim().toLowerCase();
  if (email === "") return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 320 ? email : undefined;
}

/**
 * Sets a guest's pass type, table, host and email. The database checks the pass type is an Access category of the
 * project (guest_pass_category), the host a project person (guest_host_not_on_project), and keeps them once the
 * guest is checked in (guest_entry_checked_in).
 */
/** The pass fields trimmed and checked, or undefined when one is out of range. */
function cleanGuestPass(input: GuestPassInput): GuestPassInput | undefined {
  const tableLabel = input.tableLabel?.trim() ? input.tableLabel.trim() : null;
  const guestEmail = cleanGuestEmail(input.guestEmail);
  if ((tableLabel !== null && tableLabel.length > 40) || guestEmail === undefined) return undefined;
  return {
    passCategoryId: input.passCategoryId,
    tableLabel,
    hostPersonId: input.hostPersonId,
    guestEmail,
  };
}

export async function updateGuestPass(
  db: XosClient,
  guestId: string,
  input: GuestPassInput,
): Promise<Result<null>> {
  const pass = cleanGuestPass(input);
  if (pass === undefined) return fail({ kind: "invalid", message: "guest_pass" });
  const { data, error } = await untyped(db)
    .from("guest_list_entries")
    .update({
      pass_category_id: pass.passCategoryId,
      table_label: pass.tableLabel,
      host_person_id: pass.hostPersonId,
      guest_email: pass.guestEmail,
    })
    .eq("id", guestId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data ?? []).length === 0 ? fail(NOT_FOUND) : ok(null);
}

/** What a guest pass prints (B8, the guest-pass document): an Approved or Checked In guest with a pass code. */
export interface GuestPass {
  readonly id: string;
  readonly projectId: string;
  readonly guestName: string;
  readonly plusOnes: number;
  readonly state: "Approved" | "Checked In";
  readonly passCode: string;
  readonly passCategoryCode: string | null;
  readonly passCategoryName: string | null;
  readonly tableLabel: string | null;
  /** The show the guest attends (the entry's scope node), or null for the whole project. */
  readonly showName: string | null;
  /** The project's first day (YYYY-MM-DD), printed as the show's date. */
  readonly showDay: string | null;
  /** When the guest was approved: the pass's issue time, which picks its template version. */
  readonly decidedAt: string;
}

/**
 * A guest's pass, read as the caller (advancing.packet.read on the project, through row level security). A guest who
 * is not Approved or Checked In, or has no pass code yet, answers not found, so a Requested guest has no pass.
 */
export async function getGuestPass(db: XosClient, guestId: string): Promise<Result<GuestPass>> {
  const { data: raw, error } = await untyped(db)
    .from("guest_list_entries")
    .select(
      "id, project_id, scope_node_id, guest_name, plus_ones, entry_state, pass_code, pass_category_id, table_label, decided_at",
    )
    .eq("id", guestId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  const g = raw as {
    id: string;
    project_id: string;
    scope_node_id: string | null;
    guest_name: string;
    plus_ones: number;
    entry_state: GuestState;
    pass_code: string | null;
    pass_category_id: string | null;
    table_label: string | null;
    decided_at: string | null;
  } | null;
  if (
    !g ||
    g.pass_code === null ||
    g.decided_at === null ||
    (g.entry_state !== "Approved" && g.entry_state !== "Checked In")
  ) {
    return fail(NOT_FOUND);
  }
  const [category, scope, project] = await Promise.all([
    g.pass_category_id
      ? db
          .from("credential_categories")
          .select("code, name")
          .eq("id", g.pass_category_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    g.scope_node_id
      ? db.from("scope_nodes").select("name").eq("id", g.scope_node_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from("projects").select("starts_on").eq("id", g.project_id).maybeSingle(),
  ]);
  for (const r of [category, scope, project]) if (r.error) return fail(toDataError(r.error));
  return ok({
    id: g.id,
    projectId: g.project_id,
    guestName: g.guest_name,
    plusOnes: g.plus_ones,
    state: g.entry_state,
    passCode: g.pass_code,
    passCategoryCode: category.data?.code ?? null,
    passCategoryName: category.data?.name ?? null,
    tableLabel: g.table_label,
    showName: scope.data?.name ?? null,
    showDay: project.data?.starts_on ?? null,
    decidedAt: g.decided_at,
  });
}

export type GuestEmailKind = "Invitation" | "Pass" | "Message";
export type GuestEmailState = "Queued" | "Sending" | "Sent" | "Failed" | "Suppressed" | "Skipped";

export interface GuestEmailSummary {
  readonly queued: number;
  readonly sending: number;
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly skipped: number;
  readonly skippedNoEmail: number;
  readonly skippedNotLive: number;
  readonly skippedNoPass: number;
}

/**
 * Queues an email to the selected guests (app.queue_guest_emails, 2975; advancing.rider.write). Refusals:
 * guest_email_batch (1 to 500), guest_email_rate (2,000 a day per org), guest_email_message. Returns the send id;
 * the counts come from guestEmailSendSummary.
 */
export async function queueGuestEmails(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly guestIds: readonly string[];
    readonly kind: GuestEmailKind;
    readonly subject?: string | null;
    readonly body?: string | null;
    readonly locale: "en-US" | "es-US";
  },
): Promise<Result<{ sendId: string }>> {
  const { data, error } = await untyped(db).rpc("queue_guest_emails", {
    p_project_id: input.projectId,
    p_entry_ids: [...input.guestIds],
    p_kind: input.kind,
    ...(input.subject ? { p_subject: input.subject } : {}),
    ...(input.body ? { p_body: input.body } : {}),
    p_locale: input.locale,
  });
  if (error) return fail(toDataError(error));
  return ok({ sendId: String(data) });
}

/** A send's rows counted by state and skip reason (app.guest_email_send_summary). */
export async function guestEmailSendSummary(
  db: XosClient,
  sendId: string,
): Promise<Result<GuestEmailSummary>> {
  const { data, error } = await untyped(db).rpc("guest_email_send_summary", { p_send_id: sendId });
  if (error) return fail(toDataError(error));
  const r = (data as Record<string, number>[] | null)?.[0];
  if (!r) return fail(NOT_FOUND);
  return ok({
    queued: r["queued"] ?? 0,
    sending: r["sending"] ?? 0,
    sent: r["sent"] ?? 0,
    failed: r["failed"] ?? 0,
    suppressed: r["suppressed"] ?? 0,
    skipped: r["skipped"] ?? 0,
    skippedNoEmail: r["skipped_no_email"] ?? 0,
    skippedNotLive: r["skipped_not_live"] ?? 0,
    skippedNoPass: r["skipped_no_pass"] ?? 0,
  });
}

export interface GuestEmailRow {
  readonly guestListEntryId: string;
  readonly state: GuestEmailState;
  readonly skipReason: "No Email" | "Not Live" | "No Pass" | null;
  readonly sentAt: string | null;
}

export interface GuestEmailSend {
  readonly id: string;
  readonly kind: GuestEmailKind;
  readonly subject: string | null;
  readonly locale: "en-US" | "es-US";
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly rows: readonly GuestEmailRow[];
}

/** A project's guest email sends, newest first, each with its rows' states (advancing.packet.read). */
export async function listGuestEmailSends(
  db: XosClient,
  projectId: string,
  limit = 20,
): Promise<Result<GuestEmailSend[]>> {
  const { data, error } = await untyped(db)
    .from("guest_email_sends")
    .select(
      "id, email_kind, subject, locale, created_at, created_by, guest_emails(guest_list_entry_id, send_state, skip_reason, sent_at)",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    id: string;
    email_kind: GuestEmailKind;
    subject: string | null;
    locale: "en-US" | "es-US";
    created_at: string;
    created_by: string | null;
    guest_emails: {
      guest_list_entry_id: string;
      send_state: GuestEmailState;
      skip_reason: GuestEmailRow["skipReason"];
      sent_at: string | null;
    }[];
  }[];
  return ok(
    rows.map((r) => ({
      id: r.id,
      kind: r.email_kind,
      subject: r.subject,
      locale: r.locale,
      createdAt: r.created_at,
      createdBy: r.created_by,
      rows: (r.guest_emails ?? []).map((e) => ({
        guestListEntryId: e.guest_list_entry_id,
        state: e.send_state,
        skipReason: e.skip_reason,
        sentAt: e.sent_at,
      })),
    })),
  );
}

/**
 * Why a guest would get no email of this kind, before it is queued: no address, or, for a Pass, not approved with a
 * code. The database decides again when it queues (2975) and also suppresses addresses on the org's list.
 */
export function guestEmailSkip(
  guest: Pick<GuestEntry, "guestEmail" | "state" | "passCode">,
  kind: GuestEmailKind,
): "No Email" | "Not Live" | "No Pass" | null {
  if (guest.state === "Declined") return "Not Live";
  if (!guest.guestEmail) return "No Email";
  if (kind === "Pass" && (guest.state === "Requested" || guest.passCode === null)) return "No Pass";
  return null;
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
