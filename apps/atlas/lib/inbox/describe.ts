import type { InboxItem } from "@xos/data/inbox";

/**
 * Inbox item copy (Section 11.10 rule 5, finding A59-006): every item reads as a human title and a
 * summary, from the same catalog copy the notification email uses (email.kinds.{kind}), with the
 * arguments the platform stored on the notification. No item falls back to a generic "Update" with
 * the event key underneath; a kind without email copy reads as its label and its subject's title.
 * Each item also links to where it can be opened.
 */

type Values = Record<string, string | number | Date>;

export interface InboxCopy {
  /** A message in the `platform` namespace. */
  readonly t: (key: string, values?: Record<string, string | number>) => string;
  /** A message in the `email` namespace, and whether it exists. */
  readonly email: (key: string, values?: Values) => string;
  readonly hasEmail: (key: string) => boolean;
  readonly hasPlatform: (key: string) => boolean;
  readonly money: (minor: number | null, currency: string) => string;
}

export interface InboxDescription {
  readonly summary: string;
  readonly detail: string;
  /** Where the item opens, inside the org; null when it has nowhere to go. */
  readonly href: string | null;
}

/** Arguments each kind's email copy reads beyond title and actorName, which only the notification carries. */
const NEEDS: Readonly<Record<string, readonly string[]>> = {
  "shift.assigned": ["startsAt"],
  "shift.changed": ["startsAt"],
  // "Still coming?" and no-shows (B9, 6511 and 6512); a decline may carry the worker's name.
  "shift.reconfirm": ["startsAt"],
  "shift.reconfirm_declined": ["startsAt", "workerName", "named", "reopened"],
  "shift.no_show": ["startsAt"],
  "event.invited": ["startsAt"],
  // B5 (5947): the pickup time of a transfer to drive.
  "transfer.assigned": ["startsAt"],
  "occupancy.threshold": ["percent", "count", "permitted_load"],
  "weather.alert": ["level", "hazard", "reading"],
  // 2050: which sign-in setting changed (password, email, phone, a second factor, a passkey or the recovery codes).
  "account.security_changed": ["change"],
  // A99: a recovery code used (the codes left) and sessions signed out (how many).
  "account.recovery_code_used": ["remaining"],
  "account.session_signed_out": ["count"],
  // R6a (4664): which profile facts moved to each project (uniform, travel or both).
  "account.work_details_moved": ["moved"],
  "billing.payment_failed": ["days"],
  // B16 (6051, 6052): when a pause resumes (or none), and which connected app proposed which operation.
  "billing.paused": ["resumesOn"],
  "agent.change_proposed": ["app", "operation"],
  // 2051: the rows of a validated or committed import.
  "import.finished": ["written", "refused", "skipped"],
  // Marketplace matches and expiry reminders (A89, migrations 1462 and 1463).
  "opportunity.matched": ["count", "searchName"],
  // An offer that waits on the applicant (A127, 5200).
  "offer.sent": ["orgName"],
  // P9 (5862): how long an approval has waited, and which reminder of the org's limit this is.
  "approval.reminder": ["waitingSince", "reminderNumber", "reminderLimit"],
  // A request through a reusable vendor intake link (B2, 6505).
  "vendor_intake.submitted": ["requesterName", "projectName"],
  "onboarding.item_expiring": ["days", "expiresOn"],
  "certification.expiring": ["days", "expiresOn"],
  "document.expiring": ["days", "expiresOn"],
  // Reported content (ADR 0033 decision 57, 1630): what was reported, and the outcome or the statement of reasons.
  "content_report.filed": ["subject"],
  "content_report.overdue": ["subject"],
  "content_report.decided": ["subject", "action", "statement"],
  "content.removed": ["subject", "ruleReference", "statement"],
  // P8 (6123): the project and the days an availability poll asks about.
  "availability.requested": ["projectName", "dayCount", "firstDay", "lastDay"],
  // Advancing reminders and notices (R11, 6221 and 6222).
  "advance_packet.reminder": ["reminder", "due", "outstanding", "orgName", "projectName"],
  "advance_submission.returned": ["packetTitle"],
  "submittal.returned": ["projectName"],
  "roster_entry.removed": ["partyName", "projectName"],
  "roster_entry.facts_requested": ["kind", "partyName", "projectName"],
  "roster_entry.share_revoked": ["personName", "partyName", "projectName"],
  "credential.revoked": ["projectName"],
};

/** Where a notification's subject opens, by the table it names (paths under /{org}). */
const TARGETS: Readonly<Record<string, string>> = {
  approval_instances: "approvals",
  // P9 (5860): a pass, dock booking or equipment approval opens in Approvals, where it is decided.
  subject_approvals: "approvals",
  timesheets: "crew/timesheets",
  "app.feed_posts": "knowledge/feed",
  "app.surveys": "knowledge/feed",
  "app.workforce_events": "schedule/events",
  // 1394: shift.assigned and shift.changed open the worker's shifts. Records open in inboxTarget.
  "app.shifts": "crew/shifts",
  // P8: availability.requested opens the member's availability, where the poll's Requests card is.
  "app.availability_polls": "me/work-details",
  "app.training_courses": "knowledge/training",
  "app.recognitions": "people/recognition",
  "app.support_tickets": "people/help-desk",
  "app.chat_messages": "people/chat",
  // A new or overdue report opens the moderators' queue; a decision opens nothing (its notice carries the statement).
  "app.content_reports": "people/moderation",
  "app.weather_alerts": "site-ops/weather",
  "app.occupancy_counters": "site-ops/occupancy",
  invoices: "finance/invoices",
  "app.invoices": "finance/invoices",
  incidents: "safety/incidents",
  "app.incidents": "safety/incidents",
  break_glass_sessions: "settings/security",
  report_deliveries: "reports",
};

/** Subjects that open their own row: the page and the query key it reads (B1: plans, their pins and shapes, signs). */
const ROW_TARGETS: Readonly<Record<string, readonly [path: string, key: string]>> = {
  "app.site_plans": ["places/site-plans", "peek"],
  "app.site_plan_pins": ["places/site-plans", "pin"],
  "app.site_plan_shapes": ["places/site-plans", "shape"],
  "app.signs": ["places/signage", "peek"],
};

/** A record subject: app.records from the record emitters, records from a domain event an automation notice is about. */
const RECORD_TABLES: ReadonlySet<string> = new Set(["app.records", "records"]);

export function inboxTarget(
  org: string,
  item: Pick<InboxItem, "subjectTable" | "kind"> & {
    readonly subjectId?: InboxItem["subjectId"];
    readonly args?: InboxItem["args"];
  },
): string | null {
  // A delivered report (ADR 0033 decision 77, 1621) opens the report in Saved reports, with its panel open.
  if (item.subjectTable === "app.report_definitions") {
    return item.subjectId
      ? `/${org}/reports/saved-reports?peek=${encodeURIComponent(item.subjectId)}`
      : `/${org}/reports/saved-reports`;
  }
  // A record opens itself by the key its notification carries (1600). Without one (a notification sent before 1600)
  // only an assignment has somewhere to go: My Work lists the records a person is assigned to, not those they comment
  // on or are mentioned in.
  if (item.subjectTable && RECORD_TABLES.has(item.subjectTable)) {
    const key = item.args?.["recordKey"];
    if (key) return `/${org}/r/${encodeURIComponent(key)}`;
    return item.kind === "assignment.created" ? `/${org}/my-work` : null;
  }
  // An import (2051) opens in the import wizard at the step it reached.
  if (item.subjectTable === "app.import_jobs") {
    return item.subjectId
      ? `/${org}/import?import=${encodeURIComponent(item.subjectId)}`
      : `/${org}/import`;
  }
  // A revoked share (R11, 6222) opens the person on the project's crew roster.
  if (item.kind === "roster_entry.share_revoked") {
    const key = item.args?.["projectKey"];
    return key && item.subjectId
      ? `/${org}/p/${encodeURIComponent(key)}/advancing?section=crew&peek=${encodeURIComponent(item.subjectId)}`
      : null;
  }
  const row = item.subjectTable ? ROW_TARGETS[item.subjectTable] : undefined;
  if (row) {
    return item.subjectId
      ? `/${org}/${row[0]}?${row[1]}=${encodeURIComponent(item.subjectId)}`
      : `/${org}/${row[0]}`;
  }
  const path = item.subjectTable ? TARGETS[item.subjectTable] : undefined;
  if (path) return `/${org}/${path}`;
  // A connected app's proposal (B16, 6052) waits in Personal settings, Connected apps.
  if (item.kind === "agent.change_proposed") return `/${org}/me/connected-apps`;
  if (item.kind.startsWith("billing.")) return `/${org}/settings/billing-and-plan`;
  if (item.kind.startsWith("account.")) return `/${org}/me/security`;
  return null;
}

/** An ISO 8601 instant, as message arguments carry them for date and time formats. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The arguments the copy reads, with readable defaults; null when an argument the kind needs is missing. */
function values(
  item: InboxItem,
  copy: InboxCopy,
  actorName: string | null,
  orgName: string,
): Values | null {
  const a = item.args;
  const out: Values = {
    ...a,
    title: a["title"] ?? copy.t("inbox.aRecord"),
    actorName: a["actorName"] ?? actorName ?? copy.t("inbox.someone"),
    decision: a["decision"] === "rejected" ? "rejected" : "approved",
    orgName: a["orgName"] ?? orgName,
    reason: a["reason"] ?? "",
  };
  for (const need of NEEDS[item.kind] ?? []) {
    if (a[need] === undefined) return null;
  }
  const startsAt = date(a["startsAt"]);
  if (startsAt) out["startsAt"] = startsAt;
  else delete out["startsAt"];
  // Any other ISO instant is a date for a `{x, time}` or `{x, date}` format, as the email and push copy reads it
  // (packages/platform notificationArgs): a late weather hold's called_at (6257).
  for (const [key, value] of Object.entries(a)) {
    if (key !== "startsAt" && typeof value === "string" && ISO_INSTANT.test(value)) {
      out[key] = new Date(value);
    }
  }
  const waitingSince = date(a["waitingSince"]);
  if (waitingSince) out["waitingSince"] = waitingSince;
  else if (item.kind === "approval.reminder") return null;
  // An advance reminder's due date (R11) is an instant too; without one the copy reads its other branch.
  const dueAt = date(a["dueAt"]);
  if (dueAt) out["dueAt"] = dueAt;
  else delete out["dueAt"];
  for (const key of [
    "days",
    "count",
    "written",
    "refused",
    "skipped",
    "reminderNumber",
    "reminderLimit",
    "freeRoomNights",
    "passengerCount",
    "dayCount",
    "outstanding",
  ]) {
    if (a[key] !== undefined) out[key] = Number(a[key]);
  }
  return out;
}

export function describeInboxItem(
  item: InboxItem,
  copy: InboxCopy,
  context: { readonly org: string; readonly orgName: string; readonly actorName: string | null },
): InboxDescription {
  const href = inboxTarget(context.org, item);
  if (item.approval && item.kind === "approval.requested") {
    const documentKey = `inbox.documents.${item.approval.documentType.replaceAll(" ", "")}`;
    return {
      summary: copy.t("inbox.approvalSummary", {
        document: copy.hasPlatform(documentKey) ? copy.t(documentKey) : item.approval.documentType,
        reference: item.approval.reference ?? "",
        amount: copy.money(item.approval.amountMinor, item.approval.currency ?? "USD"),
      }),
      detail: copy.t("inbox.approvalDetail", {
        actor: item.args["actorName"] ?? context.actorName ?? copy.t("inbox.someone"),
        step: item.approval.currentStep,
      }),
      href,
    };
  }
  const key = `kinds.${item.kind}`;
  const args = values(item, copy, context.actorName, context.orgName);
  if (args && copy.hasEmail(`${key}.subject`) && copy.hasEmail(`${key}.body`)) {
    return {
      summary: copy.email(`${key}.subject`, args),
      detail: copy.email(`${key}.body`, args),
      href,
    };
  }
  // No copy for the kind, or its notification lacks an argument: the kind's label and the subject's title.
  const label = copy.hasPlatform(`inbox.${key}`)
    ? copy.t(`inbox.${key}`)
    : copy.t("inbox.otherKind");
  return { summary: label, detail: item.args["title"] ?? "", href };
}
