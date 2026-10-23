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
  "event.invited": ["startsAt"],
  "occupancy.threshold": ["percent", "count", "permitted_load"],
  "weather.alert": ["level", "hazard", "reading"],
  "account.security_changed": ["change"],
  // A99: a recovery code used (the codes left) and sessions signed out (how many).
  "account.recovery_code_used": ["remaining"],
  "account.session_signed_out": ["count"],
  "billing.payment_failed": ["days"],
  // Marketplace matches and expiry reminders (A89, migrations 1462 and 1463).
  "opportunity.matched": ["count", "searchName"],
  "onboarding.item_expiring": ["days", "expiresOn"],
  "certification.expiring": ["days", "expiresOn"],
  "document.expiring": ["days", "expiresOn"],
};

/** Where a notification's subject opens, by the table it names (paths under /{org}). */
const TARGETS: Readonly<Record<string, string>> = {
  approval_instances: "approvals",
  timesheets: "crew/timesheets",
  "app.feed_posts": "knowledge/feed",
  "app.surveys": "knowledge/feed",
  "app.workforce_events": "schedule/events",
  // 1394: shift.assigned and shift.changed open the worker's shifts. Records open in inboxTarget.
  "app.shifts": "crew/shifts",
  "app.training_courses": "knowledge/training",
  "app.recognitions": "people/recognition",
  "app.support_tickets": "people/help-desk",
  "app.chat_messages": "people/chat",
  "app.weather_alerts": "site-ops/weather",
  "app.occupancy_counters": "site-ops/occupancy",
  invoices: "finance/invoices",
  "app.invoices": "finance/invoices",
  incidents: "safety/incidents",
  "app.incidents": "safety/incidents",
  break_glass_sessions: "settings/security",
  report_deliveries: "reports",
};

/** A record subject: app.records from the record emitters, records from a domain event an automation notice is about. */
const RECORD_TABLES: ReadonlySet<string> = new Set(["app.records", "records"]);

export function inboxTarget(
  org: string,
  item: Pick<InboxItem, "subjectTable" | "kind"> & { readonly args?: InboxItem["args"] },
): string | null {
  // A record opens itself by the key its notification carries (1600). Without one (a notification sent before 1600)
  // only an assignment has somewhere to go: My Work lists the records a person is assigned to, not those they comment
  // on or are mentioned in.
  if (item.subjectTable && RECORD_TABLES.has(item.subjectTable)) {
    const key = item.args?.["recordKey"];
    if (key) return `/${org}/r/${encodeURIComponent(key)}`;
    return item.kind === "assignment.created" ? `/${org}/my-work` : null;
  }
  const path = item.subjectTable ? TARGETS[item.subjectTable] : undefined;
  if (path) return `/${org}/${path}`;
  if (item.kind.startsWith("billing.")) return `/${org}/settings/billing-and-plan`;
  if (item.kind.startsWith("account.")) return `/${org}/me/security`;
  return null;
}

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
  if (a["days"] !== undefined) out["days"] = Number(a["days"]);
  if (a["count"] !== undefined) out["count"] = Number(a["count"]);
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
