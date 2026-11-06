import type { XosClient } from "./client.ts";
import type { Database } from "./database.types.ts";
import { bool, num, rpc, str, strOrNull, type Raw } from "./platform-common.ts";
import type { Result } from "./result.ts";

/**
 * The legal queue in the operator console (ADR 0167, migrations 6165 to 6168): one list of legal and security work with
 * its clock, so a one-person company does not miss one because of a full inbox. Only an operator holding legal.queue (the
 * Administrator role) reaches it, with a second factor, and every write lands in the console ledger and the item's log.
 * Due times come from the database's rules; this module never computes one.
 */

export type LegalQueueMatter = Database["app"]["Enums"]["legal_queue_matter"];
export type LegalQueueState = Database["app"]["Enums"]["legal_queue_state"];
export type LegalQueueBasis = Database["app"]["Enums"]["legal_queue_basis"];
export type LegalQueueEventKind = Database["app"]["Enums"]["legal_queue_event_kind"];

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {};

export interface LegalQueueItem {
  readonly id: string;
  readonly reference: string;
  readonly matter: LegalQueueMatter;
  readonly ruleCode: string;
  readonly basis: LegalQueueBasis;
  /** The clock is a Customer's own: the queue watches it and does not work it. */
  readonly customerClock: boolean;
  /** What the operator typed, or for a fed or system item a code the console words from its catalog. */
  readonly title: string;
  /** A fed report's or appeal's listing title, read live; null otherwise or once it is gone. */
  readonly liveTitle: string | null;
  /** On a repeat infringer review: the notices now counted. */
  readonly counted: number | null;
  readonly state: LegalQueueState;
  readonly orgName: string | null;
  readonly receivedAt: string;
  readonly firstResponseDueAt: string | null;
  readonly firstResponseAt: string | null;
  /** A DMCA restoration may not come before this. */
  readonly earliestActionAt: string | null;
  readonly dueAt: string;
  /** The next clock an open item must meet: its first response while none is recorded, then its due time. */
  readonly nextClockAt: string;
  readonly extendedAt: string | null;
  readonly closedAt: string | null;
  /** Fed from a record the system created; its state follows that record. */
  readonly fed: boolean;
  readonly overdue: boolean;
}

function toItem(value: unknown): LegalQueueItem {
  const r = obj(value);
  return {
    id: str(r["id"]),
    reference: str(r["reference"]),
    matter: str(r["matter"]) as LegalQueueMatter,
    ruleCode: str(r["rule_code"]),
    basis: str(r["basis"]) as LegalQueueBasis,
    customerClock: bool(r["customer_clock"]),
    title: str(r["title"]),
    liveTitle: strOrNull(r["live_title"]),
    counted: r["counted"] === null || r["counted"] === undefined ? null : num(r["counted"]),
    state: str(r["state"]) as LegalQueueState,
    orgName: strOrNull(r["org_name"]),
    receivedAt: str(r["received_at"]),
    firstResponseDueAt: strOrNull(r["first_response_due_at"]),
    firstResponseAt: strOrNull(r["first_response_at"]),
    earliestActionAt: strOrNull(r["earliest_action_at"]),
    dueAt: str(r["due_at"]),
    nextClockAt: str(r["next_clock_at"]),
    extendedAt: strOrNull(r["extended_at"]),
    closedAt: strOrNull(r["closed_at"]),
    fed: bool(r["fed"]),
    overdue: bool(r["overdue"]),
  };
}

export interface LegalQueue {
  /** The time zone clocks count in, for showing them as they are counted. */
  readonly timeZone: string;
  /** GHXSTSHIP's own work, by the clock that comes next. */
  readonly items: readonly LegalQueueItem[];
  /** Customer clocks the queue only watches, kept apart so they never push real work off the list. */
  readonly watched: readonly LegalQueueItem[];
  readonly summary: {
    readonly open: number;
    readonly watched: number;
    readonly overdue: number;
    readonly dueSoon: number;
  };
  /** Whether alerts are actually leaving: a clock is only as safe as this. */
  readonly delivery: {
    readonly stuck: number;
    readonly failed: number;
    /** Results of a decision or appeal on their way to a person. */
    readonly noticesStuck: number;
    readonly noticesFailed: number;
    readonly lastSentAt: string | null;
    readonly overdueWithoutAlert: number;
    /** The hourly sweep has not finished in 2 hours. */
    readonly sweepStale: boolean;
    /** An alert path failed inside the sweep in the last 24 hours. */
    readonly alertPathFailed: boolean;
    readonly webhookConfigured: boolean;
  };
  readonly repeatInfringers: readonly {
    readonly personId: string;
    readonly name: string | null;
    readonly counted: number;
    readonly windowStart: string;
    readonly thresholdMet: boolean;
  }[];
  /** Requests received per calendar year, for the yearly publication the DPA promises. */
  readonly governmentRequests: readonly { readonly year: number; readonly received: number }[];
  readonly contacts: readonly {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  }[];
  readonly outsideReviewer: OutsideReviewer | null;
  /** The rules an operator can add an item under. */
  readonly rules: readonly {
    readonly code: string;
    readonly matter: LegalQueueMatter;
    readonly dueFromDocument: boolean;
  }[];
}

export interface OutsideReviewer {
  readonly id: string;
  readonly name: string;
  readonly organization: string | null;
  readonly email: string;
  readonly appointedAt: string;
}

export async function getLegalQueue(db: XosClient, open = true): Promise<Result<LegalQueue>> {
  return rpc(db, "console_legal_queue", { p_open: open }, (data) => {
    const d = obj(data);
    const summary = obj(d["summary"]);
    const delivery = obj(d["delivery"]);
    const reviewer = d["outside_reviewer"] ? obj(d["outside_reviewer"]) : null;
    return {
      timeZone: str(d["time_zone"]),
      items: arr(d["items"]).map(toItem),
      watched: arr(d["watched"]).map(toItem),
      summary: {
        open: num(summary["open"]),
        watched: num(summary["watched"]),
        overdue: num(summary["overdue"]),
        dueSoon: num(summary["due_soon"]),
      },
      delivery: {
        stuck: num(delivery["stuck"]),
        failed: num(delivery["failed"]),
        noticesStuck: num(delivery["notices_stuck"]),
        noticesFailed: num(delivery["notices_failed"]),
        lastSentAt: strOrNull(delivery["last_sent_at"]),
        overdueWithoutAlert: num(delivery["overdue_without_alert"]),
        sweepStale: bool(delivery["sweep_stale"]),
        alertPathFailed: bool(delivery["alert_path_failed"]),
        webhookConfigured: bool(delivery["webhook_configured"]),
      },
      repeatInfringers: arr(d["repeat_infringers"]).map((x) => {
        const r = obj(x);
        return {
          personId: str(r["person_id"]),
          name: strOrNull(r["name"]),
          counted: num(r["counted"]),
          windowStart: str(r["window_start"]),
          thresholdMet: bool(r["threshold_met"]),
        };
      }),
      governmentRequests: arr(d["government_requests"]).map((x) => {
        const r = obj(x);
        return { year: num(r["year"]), received: num(r["received"]) };
      }),
      contacts: arr(d["contacts"]).map((x) => {
        const r = obj(x);
        return { id: str(r["id"]), name: str(r["name"]), email: str(r["email"]) };
      }),
      outsideReviewer: reviewer
        ? {
            id: str(reviewer["id"]),
            name: str(reviewer["name"]),
            organization: strOrNull(reviewer["organization"]),
            email: str(reviewer["email"]),
            appointedAt: str(reviewer["appointed_at"]),
          }
        : null,
      rules: arr(d["rules"]).map((x) => {
        const r = obj(x);
        return {
          code: str(r["code"]),
          matter: str(r["matter"]) as LegalQueueMatter,
          dueFromDocument: bool(r["due_from_document"]),
        };
      }),
    };
  });
}

export interface LegalQueueEvent {
  readonly id: string;
  readonly kind: LegalQueueEventKind;
  readonly fromState: LegalQueueState | null;
  readonly toState: LegalQueueState | null;
  readonly note: string | null;
  /** For an alert: the clock it was about, which the console words from its catalog. */
  readonly alertClock: "First Response" | "Due" | null;
  readonly alertClockAt: string | null;
  readonly alertOverdue: boolean;
  readonly at: string;
  readonly actorName: string | null;
}

export interface LegalQueueItemDetail extends LegalQueueItem {
  /** The time zone clocks count in, for showing them as they are counted. */
  readonly timeZone: string;
  readonly details: string | null;
  readonly requesterContact: string | null;
  readonly extensionReason: string | null;
  readonly courtActionFiled: boolean;
  readonly subjectName: string | null;
  readonly relatedId: string | null;
  readonly relatedReference: string | null;
  readonly extendable: boolean;
  /** Closing needs a fresh, documented re-review and how the person was told. */
  readonly reReviewRequired: boolean;
  /** Whether the first decider did the re-review; null until it is closed. */
  readonly reReviewSamePerson: boolean | null;
  /** The outside reviewer this appeal goes to, or who decided it. */
  readonly outsideReviewerName: string | null;
  /** A fed appeal or report is decided on its listing's moderation page. */
  readonly opportunityId: string | null;
  readonly nextStates: readonly LegalQueueState[];
  readonly events: readonly LegalQueueEvent[];
}

/** One item and its log. The database logs each view in the console ledger. */
export async function getLegalQueueItem(
  db: XosClient,
  itemId: string,
): Promise<Result<LegalQueueItemDetail>> {
  return rpc(db, "console_legal_queue_item", { p_item_id: itemId }, (data) => {
    const d = obj(data);
    return {
      ...toItem(d),
      timeZone: str(d["time_zone"]),
      details: strOrNull(d["details"]),
      requesterContact: strOrNull(d["requester_contact"]),
      extensionReason: strOrNull(d["extension_reason"]),
      courtActionFiled: bool(d["court_action_filed"]),
      subjectName: strOrNull(d["subject_name"]),
      relatedId: strOrNull(d["related_id"]),
      relatedReference: strOrNull(d["related_reference"]),
      extendable: bool(d["extendable"]),
      reReviewRequired: bool(d["re_review_required"]),
      reReviewSamePerson:
        d["re_review_same_person"] === null || d["re_review_same_person"] === undefined
          ? null
          : bool(d["re_review_same_person"]),
      outsideReviewerName: strOrNull(d["outside_reviewer_name"]),
      opportunityId: strOrNull(d["opportunity_id"]),
      nextStates: arr(d["next_states"]).map((s) => str(s) as LegalQueueState),
      events: arr(d["events"]).map((x) => {
        const r = obj(x);
        return {
          id: str(r["id"]),
          kind: str(r["kind"]) as LegalQueueEventKind,
          fromState: strOrNull(r["from_state"]) as LegalQueueState | null,
          toState: strOrNull(r["to_state"]) as LegalQueueState | null,
          note: strOrNull(r["note"]),
          alertClock: strOrNull(r["alert_clock"]) as LegalQueueEvent["alertClock"],
          alertClockAt: strOrNull(r["alert_clock_at"]),
          alertOverdue: bool(r["alert_overdue"]),
          at: str(r["at"]),
          actorName: strOrNull(r["actor_name"]),
        };
      }),
    };
  });
}

/** How many clocks are overdue, for the banner on every console page; 0 without legal.queue. */
export async function getLegalQueueOverdue(db: XosClient): Promise<Result<number>> {
  return rpc(db, "console_legal_queue_overdue", {}, (data) => num(data));
}

export interface NewLegalQueueItem {
  readonly ruleCode: string;
  readonly title: string;
  /** When the matter arrived, from the message itself, as typed in the zone the queue counts in; the clock starts here. */
  readonly receivedLocal: string;
  readonly details?: string | null;
  readonly requesterContact?: string | null;
  /** On a DMCA notice: the account it is about, for the repeat infringer count. */
  readonly subjectEmail?: string | null;
  /** On a DMCA counter-notice: the reference of the notice it answers. */
  readonly relatedReference?: string | null;
  /** The date the document sets, for a rule that takes it from there, as typed in that same zone. */
  readonly dueLocal?: string | null;
}

export async function addLegalQueueItem(
  db: XosClient,
  input: NewLegalQueueItem,
): Promise<Result<string>> {
  return rpc(
    db,
    "console_add_legal_queue_item",
    {
      p_rule_code: input.ruleCode,
      p_title: input.title,
      p_received_local: input.receivedLocal,
      p_details: input.details ?? null,
      p_requester_contact: input.requesterContact ?? null,
      p_subject_email: input.subjectEmail ?? null,
      p_related_reference: input.relatedReference ?? null,
      p_due_local: input.dueLocal ?? null,
    },
    str,
  );
}

export async function noteLegalQueueItem(
  db: XosClient,
  itemId: string,
  note: string,
): Promise<Result<string>> {
  return rpc(db, "console_note_legal_queue_item", { p_item_id: itemId, p_note: note }, str);
}

export async function recordLegalFirstResponse(
  db: XosClient,
  itemId: string,
  note: string,
): Promise<Result<string>> {
  return rpc(db, "console_record_legal_first_response", { p_item_id: itemId, p_note: note }, str);
}

export async function transitionLegalQueueItem(
  db: XosClient,
  input: {
    readonly itemId: string;
    readonly expected: LegalQueueState;
    readonly next: LegalQueueState;
    readonly reason: string;
    readonly courtActionFiled?: boolean;
    /** Closing an appeal that arrived by email: what was looked at again. */
    readonly reReviewNotes?: string | null;
    /** Closing an appeal that arrived by email: how and when the person was told. */
    readonly toldHow?: string | null;
    /** The person who made the first decision did the re-review. */
    readonly samePerson?: boolean;
    /** While an outside reviewer is appointed, this records their decision. */
    readonly outsideReviewerDecided?: boolean;
  },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_transition_legal_queue_item",
    {
      p_item_id: input.itemId,
      p_expected: input.expected,
      p_next: input.next,
      p_reason: input.reason,
      p_court_action_filed: input.courtActionFiled ?? false,
      p_re_review_notes: input.reReviewNotes ?? null,
      p_told_how: input.toldHow ?? null,
      p_same_person: input.samePerson ?? false,
      p_outside_reviewer_decided: input.outsideReviewerDecided ?? false,
    },
    str,
  );
}

export async function extendLegalQueueItem(
  db: XosClient,
  itemId: string,
  reason: string,
): Promise<Result<string>> {
  return rpc(db, "console_extend_legal_queue_item", { p_item_id: itemId, p_reason: reason }, str);
}

export async function addLegalAlertContact(
  db: XosClient,
  name: string,
  email: string,
): Promise<Result<string>> {
  return rpc(db, "console_add_legal_alert_contact", { p_name: name, p_email: email }, str);
}

export async function removeLegalAlertContact(
  db: XosClient,
  contactId: string,
): Promise<Result<null>> {
  return rpc(db, "console_remove_legal_alert_contact", { p_contact_id: contactId }, () => null);
}

export async function appointOutsideReviewer(
  db: XosClient,
  input: {
    readonly name: string;
    readonly organization: string | null;
    readonly email: string;
    readonly reason: string;
  },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_appoint_outside_reviewer",
    {
      p_name: input.name,
      p_organization: input.organization,
      p_email: input.email,
      p_reason: input.reason,
    },
    str,
  );
}

export async function endOutsideReviewer(
  db: XosClient,
  reviewerId: string,
  reason: string,
): Promise<Result<null>> {
  return rpc(
    db,
    "console_end_outside_reviewer",
    { p_reviewer_id: reviewerId, p_reason: reason },
    () => null,
  );
}
