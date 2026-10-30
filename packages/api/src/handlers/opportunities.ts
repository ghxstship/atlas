/**
 * Opportunities handlers (A28, migrations 0700 to 0775). Each operation reads through row level security and A28's
 * read models, and writes through the RPCs and policies of those migrations, so the database decides every refusal
 * (Section 8.7 scoping, the lifecycle engine, separation of duties). The frozen v1 shapes name some columns
 * differently from the schema (position for sort_order, level for standing, answer for answer_text); the mapping is
 * here. Engagements are created from an accepted application (app.create_engagement_from_application), and the engaged
 * party submits an onboarding item through app.submit_onboarding_item, as corrected in catalog/modules/opportunities.ts
 * (ADR 0023). See packages/api/README.md.
 */
import type { XosClient } from "@xos/data";
import type { Components } from "../contract/operations.generated.ts";
import { badRequest, notFound } from "../problem.ts";
import { requireOrg } from "../runtime/context.ts";
import { assertIfMatch } from "../runtime/etag.ts";
import { created, defineHandlers, noContent, ok } from "../runtime/handler.ts";
import type { HandlerSet } from "../runtime/handler.ts";
import { decodeCursor, pageSize, toPage } from "../runtime/pagination.ts";
import { bidTotal } from "@xos/data/gateway-marketplace";
import { from, handlersFor, run, tableResource } from "./support/table.ts";
import type { Row, TableResource } from "./support/table.ts";

type Engagement = Components["Engagement"];
type OnboardingItem = Components["OnboardingItem"];
type OnboardingVerification = Components["OnboardingVerification"];
type Rating = Components["Rating"];
type RatingReply = Components["RatingReply"];
type Shortlist = Components["Shortlist"];
type PoolMember = Components["PoolMember"];
type PoolLevel = Components["PoolLevel"];
type AgencySlate = Components["AgencySlate"];
type ApplicationAnswer = Components["ApplicationAnswer"];
type OpportunityQuestion = Components["OpportunityQuestion"];
type BidLine = Components["BidLine"];
type PayTransparencyRule = Components["PayTransparencyRule"];

interface AuditRow {
  id: string;
  org_id: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

const AUDIT = "id, org_id, created_at, created_by, updated_at, updated_by";

function audit(row: AuditRow) {
  return {
    id: row.id,
    org_id: row.org_id,
    created_at: row.created_at,
    created_by: row.created_by ?? "",
    updated_at: row.updated_at,
    updated_by: row.updated_by ?? "",
  };
}

function cursorAfter(cursor: string | undefined, key = "id"): string | undefined {
  return cursor === undefined ? undefined : String(decodeCursor(cursor, [key])[key]);
}

/** Reads one live row by id or answers 404, never distinguishing missing from hidden (ADR 0003). */
async function readOne<T>(
  db: XosClient,
  table: string,
  columns: string,
  id: string,
  what: string,
): Promise<T> {
  const { data, error } = await (
    db.from(table as "engagements") as unknown as {
      select(c: string): {
        eq(
          c: string,
          v: string,
        ): {
          is(c: string, v: null): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
        };
      };
    }
  )
    .select(columns)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null && error !== undefined) throw error;
  if (data === null || data === undefined)
    throw notFound(`No ${what} with this identifier is visible to you.`);
  return data as T;
}

/** One page of live rows of a table, ordered by id, with optional equality filters on mapped fields. */
async function listRows<T>(
  db: XosClient,
  table: string,
  columns: string,
  query: {
    limit?: number;
    cursor?: string;
    filter?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  },
  filters: Readonly<Record<string, string>>,
  scope?: { column: string; value: string },
): Promise<{ rows: T[]; size: number }> {
  const size = pageSize(query.limit);
  let request = (db.from(table as "engagements") as unknown as { select(c: string): Chain })
    .select(columns)
    .is("deleted_at", null);
  if (scope) request = request.eq(scope.column, scope.value);
  for (const [field, ops] of Object.entries(query.filter ?? {})) {
    const column = filters[field];
    if (column === undefined) throw badRequest(`Filtering on ${field} is not supported.`);
    for (const [op, value] of Object.entries(ops)) {
      if (op !== "eq") throw badRequest(`Only filter[${field}][eq] is supported.`);
      request = request.eq(column, value);
    }
  }
  const after = cursorAfter(query.cursor);
  if (after !== undefined) request = request.gt("id", after);
  const { data, error } = await request.order("id", { ascending: true }).limit(size + 1);
  if (error !== null && error !== undefined) throw error;
  return { rows: (data ?? []) as T[], size };
}

interface Chain extends PromiseLike<{ data: unknown; error: unknown }> {
  is(c: string, v: null): Chain;
  eq(c: string, v: string): Chain;
  gt(c: string, v: string): Chain;
  order(c: string, o: { ascending: boolean }): Chain;
  limit(n: number): Chain;
}

// Engagements -----------------------------------------------------------------------------------------------------

const ENGAGEMENT_COLUMNS = `${AUDIT}, project_id, person_id, role_type, engagement_state, application_id, worker_classification, pay_basis, arrangement, start_date, end_date, counterparty_id, roster_locks_at, counterparty:counterparties(organization_id), transitions:engagement_state_transitions(to_state, created_at), application:applications(offers(id, offer_state, deleted_at))`;

interface EngagementRow extends AuditRow {
  project_id: string;
  person_id: string | null;
  role_type: Engagement["role_type"];
  engagement_state: Engagement["engagement_state"];
  application_id: string | null;
  /** Null for Client and Sponsor engagements, which carry no work terms (1624). */
  worker_classification: string | null;
  pay_basis: string | null;
  arrangement: string | null;
  start_date: string;
  end_date: string | null;
  counterparty_id: string | null;
  /** Names lock (R5, 2656); null means no lock. */
  roster_locks_at: string | null;
  counterparty: { organization_id: string } | null;
  transitions: { to_state: string; created_at: string }[] | null;
  application: {
    offers: { id: string; offer_state: string; deleted_at: string | null }[] | null;
  } | null;
}

function firstAt(row: EngagementRow, state: string): string | null {
  const times = (row.transitions ?? [])
    .filter((t) => t.to_state === state)
    .map((t) => t.created_at);
  return times.length === 0 ? null : (times.sort()[0] ?? null);
}

function toEngagement(row: EngagementRow): Engagement {
  return {
    ...audit(row),
    person_id: row.person_id,
    organization_id: row.counterparty?.organization_id ?? null,
    project_id: row.project_id,
    offer_id:
      row.application?.offers?.find((o) => o.offer_state === "Accepted" && o.deleted_at === null)
        ?.id ?? null,
    role_type: row.role_type,
    engagement_state: row.engagement_state,
    activated_at: firstAt(row, "Active"),
    completed_at: firstAt(row, "Complete"),
    application_id: row.application_id,
    worker_classification: row.worker_classification,
    pay_basis: row.pay_basis,
    arrangement: row.arrangement,
    start_date: row.start_date,
    end_date: row.end_date,
    counterparty_id: row.counterparty_id ?? null,
    roster_locks_at: row.roster_locks_at ?? null,
  };
}

// Onboarding -------------------------------------------------------------------------------------------------------

const ITEM_COLUMNS = `${AUDIT}, engagement_id, onboarding_requirement_id, document_id, submitted_at`;

interface ItemRow extends AuditRow {
  engagement_id: string;
  onboarding_requirement_id: string;
  document_id: string | null;
  submitted_at: string | null;
}

interface ItemStatus {
  onboarding_item_id: string;
  submitted_at: string | null;
  latest_outcome: string | null;
  expires_on: string | null;
  passes: boolean | null;
  carried_over: boolean | null;
}

/** The derived item state: Passed, Carried Over, Failed, Submitted or Pending (migration 0730 onboarding_item_status). */
function itemState(status: ItemStatus | undefined): string {
  if (status?.passes) return "Passed";
  if (status?.carried_over) return "Carried Over";
  if (status?.latest_outcome === "Failed") return "Failed";
  return status?.submitted_at ? "Submitted" : "Pending";
}

async function withItemStatus(db: XosClient, rows: readonly ItemRow[]): Promise<OnboardingItem[]> {
  if (rows.length === 0) return [];
  const { data, error } = await db
    .from("onboarding_item_status")
    .select("onboarding_item_id, submitted_at, latest_outcome, expires_on, passes, carried_over")
    .in(
      "onboarding_item_id",
      rows.map((r) => r.id),
    );
  if (error !== null) throw error;
  const status = new Map(((data ?? []) as ItemStatus[]).map((s) => [s.onboarding_item_id, s]));
  return rows.map((row) => {
    const s = status.get(row.id);
    return {
      ...audit(row),
      engagement_id: row.engagement_id,
      onboarding_requirement_id: row.onboarding_requirement_id,
      document_id: row.document_id,
      onboarding_item_state: itemState(s),
      expires_on: s?.expires_on ?? null,
      carried_over: Boolean(s?.carried_over),
      submitted_at: row.submitted_at,
    };
  });
}

const VERIFICATION_COLUMNS =
  "id, org_id, created_at, created_by, updated_at, updated_by, onboarding_item_id, outcome, verified_by, verified_at, note";

interface VerificationRow extends Omit<AuditRow, "deleted_at"> {
  onboarding_item_id: string;
  outcome: "Passed" | "Failed";
  verified_by: string | null;
  verified_at: string;
  note: string | null;
}

function toVerification(row: VerificationRow): OnboardingVerification {
  return {
    ...audit(row),
    onboarding_item_id: row.onboarding_item_id,
    passed: row.outcome === "Passed",
    verified_by: row.verified_by ?? "",
    verified_at: row.verified_at,
    notes: row.note,
  };
}

// Ratings ----------------------------------------------------------------------------------------------------------

const RATING_COLUMNS = `${AUDIT}, engagement_id, rater_side, score, comment, submitted_at`;

interface RatingRow extends AuditRow {
  engagement_id: string;
  rater_side: string;
  score: number;
  comment: string | null;
  submitted_at: string;
}

/**
 * When the ratings of each engagement were released (ADR 0019 item 6): when the second rating arrived, or 14 days
 * after the engagement completed; null while held.
 */
async function releaseTimes(
  db: XosClient,
  engagementIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(engagementIds)];
  const result = new Map<string, string | null>();
  if (ids.length === 0) return result;
  const [ratings, completions] = await Promise.all([
    db
      .from("ratings")
      .select("engagement_id, submitted_at")
      .in("engagement_id", ids)
      .is("deleted_at", null),
    db
      .from("engagement_state_transitions")
      .select("engagement_id, created_at")
      .in("engagement_id", ids)
      .eq("to_state", "Complete"),
  ]);
  if (ratings.error !== null) throw ratings.error;
  if (completions.error !== null) throw completions.error;
  for (const id of ids) {
    const both = (ratings.data ?? [])
      .filter((r) => r.engagement_id === id)
      .map((r) => r.submitted_at);
    const completedAt = (completions.data ?? []).find((c) => c.engagement_id === id)?.created_at;
    const lapse = completedAt
      ? new Date(Date.parse(completedAt) + 14 * 86_400_000).toISOString()
      : null;
    const second = both.length >= 2 ? (both.sort().at(-1) ?? null) : null;
    const candidates = [second, lapse && Date.parse(lapse) <= Date.now() ? lapse : null].filter(
      (v): v is string => v !== null,
    );
    result.set(id, candidates.length === 0 ? null : (candidates.sort()[0] ?? null));
  }
  return result;
}

function toRating(row: RatingRow, released: Map<string, string | null>): Rating {
  return {
    ...audit(row),
    engagement_id: row.engagement_id,
    rater_side: row.rater_side,
    score: row.score,
    comment: row.comment,
    released_at: released.get(row.engagement_id) ?? null,
  };
}

const REPLY_COLUMNS = `${AUDIT}, rating_id, body`;
interface ReplyRow extends AuditRow {
  rating_id: string;
  body: string;
}
const toReply = (row: ReplyRow): RatingReply => ({
  ...audit(row),
  rating_id: row.rating_id,
  body: row.body,
});

// Selection --------------------------------------------------------------------------------------------------------

const SHORTLIST_COLUMNS = `${AUDIT}, opportunity_id, application_id, rank`;
interface ShortlistRow extends AuditRow {
  opportunity_id: string;
  application_id: string;
  rank: number;
}
const toShortlist = (row: ShortlistRow): Shortlist => ({
  ...audit(row),
  opportunity_id: row.opportunity_id,
  application_id: row.application_id,
  rank: row.rank,
});

const SLATE_COLUMNS = `${AUDIT}, application_id, person_id`;
interface SlateRow extends AuditRow {
  application_id: string;
  person_id: string;
}
const toSlate = (row: SlateRow): AgencySlate => ({
  ...audit(row),
  application_id: row.application_id,
  person_id: row.person_id,
});

const ANSWER_COLUMNS = `${AUDIT}, application_id, opportunity_question_id, answer_text`;
interface AnswerRow extends AuditRow {
  application_id: string;
  opportunity_question_id: string;
  answer_text: string;
}
const toAnswer = (row: AnswerRow): ApplicationAnswer => ({
  ...audit(row),
  application_id: row.application_id,
  opportunity_question_id: row.opportunity_question_id,
  answer: row.answer_text,
});

const QUESTION_COLUMNS = `${AUDIT}, opportunity_id, sort_order, prompt, is_required`;
interface QuestionRow extends AuditRow {
  opportunity_id: string;
  sort_order: number;
  prompt: string;
  is_required: boolean;
}
const toQuestion = (row: QuestionRow): OpportunityQuestion => ({
  ...audit(row),
  opportunity_id: row.opportunity_id,
  position: row.sort_order,
  prompt: row.prompt,
  required: row.is_required,
});

const BID_LINE_COLUMNS = `${AUDIT}, bid_id, description, quantity, unit_price_minor, bid:bids(currency_code)`;
interface BidLineRow extends AuditRow {
  bid_id: string;
  description: string;
  quantity: number;
  unit_price_minor: number | null;
  bid: { currency_code: string } | null;
}
const toBidLine = (row: BidLineRow): BidLine => ({
  ...audit(row),
  bid_id: row.bid_id,
  description: row.description,
  quantity: Number(row.quantity),
  unit_price_minor: row.unit_price_minor,
  currency: row.bid?.currency_code ?? "",
});

// Pools ------------------------------------------------------------------------------------------------------------

const MEMBER_COLUMNS = `${AUDIT}, talent_pool_id, person_id, organization_id, standing, reason, review_on`;
interface MemberRow extends AuditRow {
  talent_pool_id: string;
  person_id: string | null;
  organization_id: string | null;
  standing: PoolLevel;
  reason: string | null;
  review_on: string | null;
}
const toMember = (row: MemberRow): PoolMember => ({
  ...audit(row),
  talent_pool_id: row.talent_pool_id,
  person_id: row.person_id,
  organization_id: row.organization_id,
  level: row.standing,
  reason: row.reason,
  review_on: row.review_on,
  rehire_eligible: row.standing !== "Do Not Engage",
});

/** Rehire eligibility is the standing seen from outside: only Do Not Engage is ineligible, so the two must agree. */
function assertEligibility(level: PoolLevel, rehireEligible: boolean | undefined): void {
  if (rehireEligible !== undefined && rehireEligible !== (level !== "Do Not Engage")) {
    throw badRequest("rehire_eligible is false exactly when level is Do Not Engage.");
  }
}

async function writeOne<T>(promise: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error !== null && error !== undefined) throw error;
  if (data === null || data === undefined)
    throw notFound("The row is not visible to you after the write.");
  return data as T;
}

// Handlers ---------------------------------------------------------------------------------------------------------

// A04P (API parity, ADR 0023) ---------------------------------------------------------------------------------------
// Opportunities and their positions and requirements, applications, bids, interviews, engagement documents,
// onboarding requirements, talent pools, onboarding verification reads and agency slate writes. Each is one table read
// and written as the caller; state changes go through A28's transition RPCs.

// Inserts leave org_id to the database (the insert grants omit it; derive_org_id fills it).
const opportunities = tableResource("opportunities", {
  orgColumn: false,
  fixed: ["project_id", "role_type"],
});
const applications = tableResource("applications", { orgColumn: false });
const engagementDocuments = tableResource("engagementDocuments");

/** A bid's NULL-aware total from its lines and whether it is still sealed (before the opportunity deadline). */
async function bidContract(row: Row, context: { db: XosClient }): Promise<Row> {
  const lines = await run<{ quantity: number; unit_price_minor: number | null }[]>(
    from(context.db, "bid_lines")
      .select("quantity, unit_price_minor")
      .eq("bid_id", row["id"])
      .is("deleted_at", null),
  );
  const application = await run<{ opportunity_id: string } | null>(
    from(context.db, "applications")
      .select("opportunity_id")
      .eq("id", row["application_id"])
      .maybeSingle(),
  );
  const opportunity =
    application === null
      ? null
      : await run<{ deadline_at: string | null } | null>(
          from(context.db, "opportunities")
            .select("deadline_at")
            .eq("id", application.opportunity_id)
            .maybeSingle(),
        );
  const deadline = opportunity?.deadline_at ?? null;
  return {
    ...row,
    total: {
      total_minor: bidTotal(
        lines.map((l) => ({ quantity: Number(l.quantity), unitPriceMinor: l.unit_price_minor })),
      ),
      currency: String(row["currency_code"]).trim(),
      unpriced_count: lines.filter((l) => l.unit_price_minor === null).length,
    },
    sealed: deadline === null || Date.parse(deadline) > Date.now(),
  };
}

const bids = tableResource("bids", {
  orgColumn: false,
  derived: ["total", "sealed"],
  extraColumns: ["currency_code", "application_id"],
  toContract: bidContract,
});

const verifications = tableResource("onboardingVerifications", {
  derived: ["passed", "notes"],
  extraColumns: ["outcome", "note"],
  toContract: (row) => ({
    ...row,
    passed: row["outcome"] === "Passed",
    notes: row["note"] ?? null,
  }),
});

/** Runs a transition RPC and returns the row read again in the contract shape. */
async function transitioned(
  resource: TableResource,
  context: Parameters<TableResource["read"]>[0],
  id: string,
  rpcName: string,
  idArg: string,
  body: { expected_state: string; to_state: string; reason?: string },
) {
  await resource.read(context, id, [resource.key]);
  const { error } = await context.db.rpc(
    rpcName as "transition_opportunity",
    {
      [idArg]: id,
      p_expected: body.expected_state,
      p_next: body.to_state,
      p_reason: body.reason ?? `Moved to ${body.to_state}.`,
    } as never,
  );
  if (error !== null) throw error;
  return resource.read(context, id);
}

const parity = {
  ...handlersFor("Opportunities", opportunities),
  ...handlersFor("Opportunities", tableResource("opportunityPositions")),
  ...handlersFor("Opportunities", tableResource("opportunityRequirements")),
  ...handlersFor("Opportunities", applications),
  ...handlersFor("Opportunities", bids),
  ...handlersFor("Opportunities", tableResource("interviews")),
  ...handlersFor("Opportunities", engagementDocuments),
  ...handlersFor("Opportunities", tableResource("onboardingRequirements")),
  ...handlersFor("Opportunities", tableResource("talentPools")),
  ...handlersFor("Opportunities", verifications),
  ...handlersFor("Opportunities", tableResource("agencySlates", { verbs: ["create", "delete"] })),

  "opportunities.transition": async ({ params, body }, context) =>
    ok(
      (await transitioned(
        opportunities,
        context,
        params.id,
        "transition_opportunity",
        "p_opportunity_id",
        body,
      )) as Components["Opportunity"],
    ),

  "applications.transition": async ({ params, body }, context) =>
    ok(
      (await transitioned(
        applications,
        context,
        params.id,
        "transition_application",
        "p_application_id",
        body,
      )) as Components["Application"],
    ),

  "engagementDocuments.transition": async ({ params, body }, context) =>
    ok(
      (await transitioned(
        engagementDocuments,
        context,
        params.id,
        "transition_engagement_document",
        "p_document_id",
        body,
      )) as Components["EngagementDocument"],
    ),
} satisfies HandlerSet<"Opportunities">;

export const handlers = defineHandlers("Opportunities", {
  ...parity,
  "engagements.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<EngagementRow>(
      context.db,
      "engagements",
      ENGAGEMENT_COLUMNS,
      query,
      {
        project_id: "project_id",
        person_id: "person_id",
        role_type: "role_type",
        engagement_state: "engagement_state",
      },
      { column: "org_id", value: org.id },
    );
    return ok(toPage(rows.map(toEngagement), size, (row) => ({ id: row.id })));
  },

  "engagements.get": async ({ params }, { db }) =>
    ok(
      toEngagement(
        await readOne<EngagementRow>(
          db,
          "engagements",
          ENGAGEMENT_COLUMNS,
          params.id,
          "engagement",
        ),
      ),
    ),

  "engagements.create": async ({ body }, { db }) => {
    const { data, error } = await db.rpc("create_engagement_from_application", {
      p_application_id: body.application_id,
      p_worker_classification: body.worker_classification,
      p_pay_basis: (body.pay_basis ?? null) as string,
      p_arrangement: (body.arrangement ?? null) as string,
      p_start_date: (body.start_date ?? null) as string,
      p_end_date: (body.end_date ?? null) as string,
    });
    if (error !== null) throw error;
    return created(
      toEngagement(
        await readOne<EngagementRow>(
          db,
          "engagements",
          ENGAGEMENT_COLUMNS,
          String(data),
          "engagement",
        ),
      ),
    );
  },

  "engagements.transition": async ({ params, body }, { db }) => {
    const { error } = await db.rpc("transition_engagement", {
      p_engagement_id: params.id,
      p_expected: body.expected_state,
      p_next: body.to_state,
      p_reason: body.reason ?? `Moved to ${body.to_state}.`,
    });
    if (error !== null) throw error;
    return ok(
      toEngagement(
        await readOne<EngagementRow>(
          db,
          "engagements",
          ENGAGEMENT_COLUMNS,
          params.id,
          "engagement",
        ),
      ),
    );
  },

  // The names lock (R5, G-142): app.set_roster_lock decides authority and refusals.
  "engagements.setRosterLock": async ({ params, body }, { db }) => {
    const { error } = await db.rpc("set_roster_lock", {
      p_engagement_id: params.id,
      p_locks_at: (body.locks_at ?? null) as string,
    });
    if (error !== null) throw error;
    return ok(
      toEngagement(
        await readOne<EngagementRow>(db, "engagements", ENGAGEMENT_COLUMNS, params.id, "engagement"),
      ),
    );
  },

  "onboardingItems.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<ItemRow>(
      context.db,
      "onboarding_items",
      ITEM_COLUMNS,
      query,
      { engagement_id: "engagement_id", onboarding_requirement_id: "onboarding_requirement_id" },
      { column: "org_id", value: org.id },
    );
    const page = toPage(rows, size, (row) => ({ id: row.id }));
    return ok({ data: await withItemStatus(context.db, page.data), next_cursor: page.next_cursor });
  },

  "onboardingItems.get": async ({ params }, { db }) => {
    const row = await readOne<ItemRow>(
      db,
      "onboarding_items",
      ITEM_COLUMNS,
      params.id,
      "onboarding item",
    );
    const [item] = await withItemStatus(db, [row]);
    return ok(item as OnboardingItem);
  },

  "onboardingItems.create": async ({ body }, { db }) => {
    const row = await writeOne<ItemRow>(
      db
        .from("onboarding_items")
        .insert({
          engagement_id: body.engagement_id,
          onboarding_requirement_id: body.onboarding_requirement_id,
        } as never)
        .select(ITEM_COLUMNS)
        .single(),
    );
    const [item] = await withItemStatus(db, [row]);
    return created(item as OnboardingItem);
  },

  "onboardingItems.submit": async ({ params, body }, { db }) => {
    await readOne<ItemRow>(db, "onboarding_items", "id", params.id, "onboarding item");
    const { error } = await db.rpc("submit_onboarding_item", {
      p_item_id: params.id,
      ...(body.document_id === undefined || body.document_id === null
        ? {}
        : { p_document_id: body.document_id }),
    });
    if (error !== null) throw error;
    const row = await readOne<ItemRow>(
      db,
      "onboarding_items",
      ITEM_COLUMNS,
      params.id,
      "onboarding item",
    );
    const [item] = await withItemStatus(db, [row]);
    return ok(item as OnboardingItem);
  },

  "onboardingVerifications.create": async ({ body }, { db }) => {
    const row = await writeOne<VerificationRow>(
      db
        .from("onboarding_verifications")
        .insert({
          onboarding_item_id: body.onboarding_item_id,
          outcome: body.passed ? "Passed" : "Failed",
          note: body.notes ?? null,
        } as never)
        .select(VERIFICATION_COLUMNS)
        .single(),
    );
    return created(toVerification(row));
  },

  "ratings.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<RatingRow>(
      context.db,
      "ratings",
      RATING_COLUMNS,
      query,
      { engagement_id: "engagement_id", rater_side: "rater_side" },
      { column: "org_id", value: org.id },
    );
    const page = toPage(rows, size, (row) => ({ id: row.id }));
    const released = await releaseTimes(
      context.db,
      page.data.map((r) => r.engagement_id),
    );
    return ok({ data: page.data.map((r) => toRating(r, released)), next_cursor: page.next_cursor });
  },

  "ratings.get": async ({ params }, { db }) => {
    const row = await readOne<RatingRow>(db, "ratings", RATING_COLUMNS, params.id, "rating");
    return ok(toRating(row, await releaseTimes(db, [row.engagement_id])));
  },

  "ratings.create": async ({ body }, { db }) => {
    const row = await writeOne<RatingRow>(
      db
        .from("ratings")
        .insert({
          engagement_id: body.engagement_id,
          rater_side: body.rater_side,
          score: body.score,
          comment: body.comment ?? null,
        } as never)
        .select(RATING_COLUMNS)
        .single(),
    );
    return created(toRating(row, await releaseTimes(db, [row.engagement_id])));
  },

  "ratingReplies.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<ReplyRow>(
      context.db,
      "rating_replies",
      REPLY_COLUMNS,
      query,
      { rating_id: "rating_id" },
      { column: "org_id", value: org.id },
    );
    return ok(toPage(rows.map(toReply), size, (row) => ({ id: row.id })));
  },

  "ratingReplies.get": async ({ params }, { db }) =>
    ok(
      toReply(
        await readOne<ReplyRow>(db, "rating_replies", REPLY_COLUMNS, params.id, "rating reply"),
      ),
    ),

  "ratingReplies.create": async ({ body }, { db }) =>
    created(
      toReply(
        await writeOne<ReplyRow>(
          db
            .from("rating_replies")
            .insert({ rating_id: body.rating_id, body: body.body } as never)
            .select(REPLY_COLUMNS)
            .single(),
        ),
      ),
    ),

  "shortlistEntries.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<ShortlistRow>(
      context.db,
      "shortlists",
      SHORTLIST_COLUMNS,
      query,
      { opportunity_id: "opportunity_id", application_id: "application_id" },
      { column: "org_id", value: org.id },
    );
    return ok(toPage(rows.map(toShortlist), size, (row) => ({ id: row.id })));
  },

  "shortlistEntries.get": async ({ params }, { db }) =>
    ok(
      toShortlist(
        await readOne<ShortlistRow>(
          db,
          "shortlists",
          SHORTLIST_COLUMNS,
          params.id,
          "shortlist entry",
        ),
      ),
    ),

  "shortlistEntries.create": async ({ body }, { db }) => {
    let rank = body.rank ?? null;
    if (rank === null) {
      const { data, error } = await db
        .from("shortlists")
        .select("rank")
        .eq("opportunity_id", body.opportunity_id)
        .is("deleted_at", null)
        .order("rank", { ascending: false })
        .limit(1);
      if (error !== null) throw error;
      rank = ((data ?? [])[0]?.rank ?? 0) + 1;
    }
    const row = await writeOne<ShortlistRow>(
      db
        .from("shortlists")
        .insert({
          opportunity_id: body.opportunity_id,
          application_id: body.application_id,
          rank,
        } as never)
        .select(SHORTLIST_COLUMNS)
        .single(),
    );
    return created(toShortlist(row));
  },

  "shortlistEntries.update": async ({ params, body, ifMatch }, { db }) => {
    const current = toShortlist(
      await readOne<ShortlistRow>(
        db,
        "shortlists",
        SHORTLIST_COLUMNS,
        params.id,
        "shortlist entry",
      ),
    );
    assertIfMatch(ifMatch ?? "*", current);
    if (body.rank === undefined) return ok(current);
    if (body.rank === null)
      throw badRequest(
        "A shortlist entry keeps a rank; delete the entry to take it off the shortlist.",
      );
    const row = await writeOne<ShortlistRow>(
      db
        .from("shortlists")
        .update({ rank: body.rank } as never)
        .eq("id", params.id)
        .select(SHORTLIST_COLUMNS)
        .single(),
    );
    return ok(toShortlist(row));
  },

  "shortlistEntries.delete": async ({ params }, { db }) => {
    await readOne<ShortlistRow>(db, "shortlists", "id", params.id, "shortlist entry");
    const { error } = await db
      .from("shortlists")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", params.id);
    if (error !== null) throw error;
    return noContent();
  },

  "poolMembers.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<MemberRow>(
      context.db,
      "pool_members",
      MEMBER_COLUMNS,
      query,
      {
        talent_pool_id: "talent_pool_id",
        person_id: "person_id",
        organization_id: "organization_id",
        level: "standing",
      },
      { column: "org_id", value: org.id },
    );
    return ok(toPage(rows.map(toMember), size, (row) => ({ id: row.id })));
  },

  "poolMembers.get": async ({ params }, { db }) =>
    ok(
      toMember(
        await readOne<MemberRow>(db, "pool_members", MEMBER_COLUMNS, params.id, "pool member"),
      ),
    ),

  "poolMembers.create": async ({ body }, { db }) => {
    assertEligibility(body.level, body.rehire_eligible);
    const row = await writeOne<MemberRow>(
      db
        .from("pool_members")
        .insert({
          talent_pool_id: body.talent_pool_id,
          person_id: body.person_id ?? null,
          organization_id: body.organization_id ?? null,
          standing: body.level,
          reason: body.reason ?? null,
          review_on: body.review_on ?? null,
        } as never)
        .select(MEMBER_COLUMNS)
        .single(),
    );
    return created(toMember(row));
  },

  "poolMembers.update": async ({ params, body, ifMatch }, { db }) => {
    const current = toMember(
      await readOne<MemberRow>(db, "pool_members", MEMBER_COLUMNS, params.id, "pool member"),
    );
    assertIfMatch(ifMatch ?? "*", current);
    const level = body.level ?? current.level;
    assertEligibility(level, body.rehire_eligible);
    const patch: Record<string, unknown> = { standing: level };
    if (body.reason !== undefined) patch["reason"] = body.reason;
    if (body.review_on !== undefined) patch["review_on"] = body.review_on;
    if (body.person_id !== undefined) patch["person_id"] = body.person_id;
    if (body.organization_id !== undefined) patch["organization_id"] = body.organization_id;
    const row = await writeOne<MemberRow>(
      db
        .from("pool_members")
        .update(patch as never)
        .eq("id", params.id)
        .select(MEMBER_COLUMNS)
        .single(),
    );
    return ok(toMember(row));
  },

  "poolMembers.delete": async ({ params }, { db }) => {
    await readOne<MemberRow>(db, "pool_members", "id", params.id, "pool member");
    const { error } = await db
      .from("pool_members")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", params.id);
    if (error !== null) throw error;
    return noContent();
  },

  "agencySlates.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<SlateRow>(
      context.db,
      "agency_slates",
      SLATE_COLUMNS,
      query,
      { application_id: "application_id", person_id: "person_id" },
      { column: "org_id", value: org.id },
    );
    return ok(toPage(rows.map(toSlate), size, (row) => ({ id: row.id })));
  },

  "agencySlates.get": async ({ params }, { db }) =>
    ok(
      toSlate(
        await readOne<SlateRow>(
          db,
          "agency_slates",
          SLATE_COLUMNS,
          params.id,
          "agency slate entry",
        ),
      ),
    ),

  "applicationAnswers.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<AnswerRow>(
      context.db,
      "application_answers",
      ANSWER_COLUMNS,
      query,
      { application_id: "application_id", opportunity_question_id: "opportunity_question_id" },
      { column: "org_id", value: org.id },
    );
    return ok(toPage(rows.map(toAnswer), size, (row) => ({ id: row.id })));
  },

  "applicationAnswers.get": async ({ params }, { db }) =>
    ok(
      toAnswer(
        await readOne<AnswerRow>(
          db,
          "application_answers",
          ANSWER_COLUMNS,
          params.id,
          "application answer",
        ),
      ),
    ),

  "applicationAnswers.create": async ({ body }, { db }) =>
    created(
      toAnswer(
        await writeOne<AnswerRow>(
          db
            .from("application_answers")
            .insert({
              application_id: body.application_id,
              opportunity_question_id: body.opportunity_question_id,
              answer_text: body.answer,
            } as never)
            .select(ANSWER_COLUMNS)
            .single(),
        ),
      ),
    ),

  "opportunityQuestions.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<QuestionRow>(
      context.db,
      "opportunity_questions",
      QUESTION_COLUMNS,
      query,
      { opportunity_id: "opportunity_id" },
      { column: "org_id", value: org.id },
    );
    return ok(toPage(rows.map(toQuestion), size, (row) => ({ id: row.id })));
  },

  "opportunityQuestions.get": async ({ params }, { db }) =>
    ok(
      toQuestion(
        await readOne<QuestionRow>(
          db,
          "opportunity_questions",
          QUESTION_COLUMNS,
          params.id,
          "opportunity question",
        ),
      ),
    ),

  "opportunityQuestions.create": async ({ body }, { db }) =>
    created(
      toQuestion(
        await writeOne<QuestionRow>(
          db
            .from("opportunity_questions")
            .insert({
              opportunity_id: body.opportunity_id,
              sort_order: body.position,
              prompt: body.prompt,
              is_required: body.required,
            } as never)
            .select(QUESTION_COLUMNS)
            .single(),
        ),
      ),
    ),

  "opportunityQuestions.update": async ({ params, body, ifMatch }, { db }) => {
    const current = toQuestion(
      await readOne<QuestionRow>(
        db,
        "opportunity_questions",
        QUESTION_COLUMNS,
        params.id,
        "opportunity question",
      ),
    );
    assertIfMatch(ifMatch ?? "*", current);
    const patch: Record<string, unknown> = {};
    if (body.position !== undefined) patch["sort_order"] = body.position;
    if (body.prompt !== undefined) patch["prompt"] = body.prompt;
    if (body.required !== undefined) patch["is_required"] = body.required;
    if (Object.keys(patch).length === 0) return ok(current);
    const row = await writeOne<QuestionRow>(
      db
        .from("opportunity_questions")
        .update(patch as never)
        .eq("id", params.id)
        .select(QUESTION_COLUMNS)
        .single(),
    );
    return ok(toQuestion(row));
  },

  "opportunityQuestions.delete": async ({ params }, { db }) => {
    await readOne<QuestionRow>(
      db,
      "opportunity_questions",
      "id",
      params.id,
      "opportunity question",
    );
    const { error } = await db
      .from("opportunity_questions")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", params.id);
    if (error !== null) throw error;
    return noContent();
  },

  "bidLines.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const { rows, size } = await listRows<BidLineRow>(
      context.db,
      "bid_lines",
      BID_LINE_COLUMNS,
      query,
      { bid_id: "bid_id" },
      { column: "org_id", value: org.id },
    );
    return ok(toPage(rows.map(toBidLine), size, (row) => ({ id: row.id })));
  },

  "bidLines.get": async ({ params }, { db }) =>
    ok(
      toBidLine(
        await readOne<BidLineRow>(db, "bid_lines", BID_LINE_COLUMNS, params.id, "bid line"),
      ),
    ),

  "bidLines.create": async ({ body }, { db }) =>
    created(
      toBidLine(
        await writeOne<BidLineRow>(
          db
            .from("bid_lines")
            .insert({
              bid_id: body.bid_id,
              description: body.description,
              ...(body.quantity === undefined ? {} : { quantity: body.quantity }),
              unit_price_minor: body.unit_price_minor ?? null,
            } as never)
            .select(BID_LINE_COLUMNS)
            .single(),
        ),
      ),
    ),

  "bidLines.update": async ({ params, body, ifMatch }, { db }) => {
    const current = toBidLine(
      await readOne<BidLineRow>(db, "bid_lines", BID_LINE_COLUMNS, params.id, "bid line"),
    );
    assertIfMatch(ifMatch ?? "*", current);
    const patch: Record<string, unknown> = {};
    if (body.description !== undefined) patch["description"] = body.description;
    if (body.quantity !== undefined) patch["quantity"] = body.quantity;
    if (body.unit_price_minor !== undefined) patch["unit_price_minor"] = body.unit_price_minor;
    if (Object.keys(patch).length === 0) return ok(current);
    const row = await writeOne<BidLineRow>(
      db
        .from("bid_lines")
        .update(patch as never)
        .eq("id", params.id)
        .select(BID_LINE_COLUMNS)
        .single(),
    );
    return ok(toBidLine(row));
  },

  "bidLines.delete": async ({ params }, { db }) => {
    await readOne<BidLineRow>(db, "bid_lines", "id", params.id, "bid line");
    const { error } = await db
      .from("bid_lines")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", params.id);
    if (error !== null) throw error;
    return noContent();
  },

  "payTransparencyRules.list": async ({ query }, { db }) => {
    const size = pageSize(query.limit);
    let request = db
      .from("pay_transparency_rules")
      .select("jurisdiction_id, requires_pay_range, effective_from")
      .order("jurisdiction_id", { ascending: true })
      .limit(size + 1);
    const after = cursorAfter(query.cursor, "jurisdiction_id");
    if (after !== undefined) request = request.gt("jurisdiction_id", after);
    const { data, error } = await request;
    if (error !== null) throw error;
    const rows: PayTransparencyRule[] = (data ?? []).map((r) => ({
      jurisdiction_id: r.jurisdiction_id ?? "",
      range_required: Boolean(r.requires_pay_range),
      effective_from: r.effective_from ?? "",
    }));
    return ok(toPage(rows, size, (row) => ({ jurisdiction_id: row.jurisdiction_id })));
  },
});
