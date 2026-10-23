import { getMessages, locales } from "@xos/i18n";
import type { InboxItem } from "@xos/data/inbox";
import { NOTIFICATION_KINDS } from "@xos/schemas/notifications";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { describeInboxItem, inboxTarget, type InboxCopy } from "../lib/inbox/describe";
import { neighbourOf } from "../lib/inbox/focus";

/**
 * Finding A59-006: every Inbox item reads as a human title and summary. Each notification kind the
 * platform emits (platform.inbox.kinds) is described with the arguments its emitter stores, in every
 * locale, and none falls back to the bare kind label, prints "undefined" or leaves a brace.
 */

type Tree = { readonly [key: string]: string | Tree };

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

function copyFor(locale: (typeof locales)[number]): InboxCopy {
  const messages = getMessages(locale) as unknown as Record<string, Tree>;
  const platform = messages["platform"] as Tree;
  const email = messages["email"] as Tree;
  const format = (tree: Tree, key: string, values?: Record<string, unknown>) => {
    const source = lookup(tree, key);
    if (source === undefined) throw new Error(`missing ${key}`);
    return String(new IntlMessageFormat(source, locale).format(values as never));
  };
  return {
    t: (key, values) => format(platform, key, values),
    email: (key, values) => format(email, key, values),
    hasEmail: (key) => lookup(email, key) !== undefined,
    hasPlatform: (key) => lookup(platform, key) !== undefined,
    money: (minor, currency) =>
      minor === null
        ? ""
        : new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100),
  };
}

/** The arguments each emitter stores (the seeded notifications and the notify call sites). */
const ARGS: Readonly<Record<string, Record<string, string>>> = {
  "access.break_glass_started": {
    orgName: "Demo Productions",
    reason: "Owner locked out by the allow-list",
  },
  "account.security_changed": { change: "password" },
  // A99's account notices (1560, 1561), as private.notify_account stores them.
  "account.recovery_code_used": { remaining: "9" },
  "account.session_signed_out": { count: "2" },
  "announcement.posted": { title: "Wristband Change Friday" },
  "approval.requested": { title: "Purchase Order 41", actorName: "Demo Producer" },
  "approval.decided": { title: "Purchase Order 41", actorName: "Demo Admin", decision: "approved" },
  "assignment.created": { title: "NWS-12 Production Meeting" },
  // A91's automation kinds (1481), as app.send_automation_notice, the failure notice and the pause store them.
  "automation.notice": {
    automationName: "Pick up tasks",
    title: "New task: Call the venue",
    body: "Call the venue needs a look.",
  },
  "automation.failed": {
    automationName: "Pick up tasks",
    error: "A Task title starts with an imperative verb.",
  },
  "automation.paused": {
    automationName: "Pick up tasks",
    ownerName: "Demo Admin",
    reason: "owner_left_org",
  },
  "billing.payment_failed": { days: "3" },
  "billing.read_only": {},
  "comment.created": { title: "NWS-12 Production Meeting" },
  "event.invited": { title: "Show Day Safety Briefing", startsAt: "2026-10-21T09:00:00+00:00" },
  "export.ready": { title: "Records export" },
  "help_request.assigned": { title: "Dock tablet will not sign in", team: "Site IT Desk" },
  "import.finished": { title: "Crew import" },
  "incident.reported": { title: "NWS-32 Slip at dock" },
  "invoice.approved": { title: "INV-0042" },
  "invoice.submitted": { title: "INV-0042" },
  "invoice.scheduled": { title: "INV-0042" },
  "invoice.paid": { title: "INV-0042" },
  "mention.created": { title: "NWS-12 Production Meeting" },
  "message.received": { kind: "Text" },
  "occupancy.threshold": { title: "Main Gate", percent: "90", count: "450", permitted_load: "500" },
  "recognition.received": { title: "Re-rigged the stage left truss in record time." },
  "report.delivered": { title: "Weekly labor" },
  "shift.assigned": { title: "Stagehand · Load-in", startsAt: "2027-03-08T07:00:00Z" },
  "shift.changed": { title: "Stagehand · Load-in", startsAt: "2027-03-08T08:00:00Z" },
  "survey.opened": { title: "Load-In Pulse", anonymous: "true" },
  "training.assigned": { title: "Rigging Basics for Crew", due_on: "2026-10-27" },
  "weather.alert": { level: "Monitor", hazard: "Wind", reading: "24" },
  // A79's org lifecycle kinds (1350 to 1355), as their notify calls store them (dates as epoch milliseconds).
  "billing.trial_ending": { days: "3", plan: "pro", ends_at: "1795000000000" },
  "billing.trial_ended": { plan: "pro" },
  "organization.deletion_requested": { recover_until: "1795000000000" },
  "organization.deletion_recovered": {},
  "organization.ownership_offered": { expires_at: "1795000000000" },
  "organization.ownership_accepted": { actorName: "Dana Reyes" },
  "organization.ownership_declined": { actorName: "Dana Reyes" },
  "organization.white_label_reverting": { plan: "pro", until: "1795000000000" },
  "organization.white_label_reverted": { plan: "pro", until: "1795000000000" },
  "partner.client_left": { org: "Tidewater Events" },
  // A89: marketplace matches and expiry reminders (1462, 1463).
  "opportunity.matched": {
    title: "Festival Truss Riggers",
    orgName: "Demo Productions",
    searchName: "Truss calls",
    count: "1",
  },
  "onboarding.item_expiring": {
    title: "Certificate of Insurance",
    days: "7",
    expiresOn: "2026-10-28",
  },
  "certification.expiring": { title: "First Aid", days: "30", expiresOn: "2026-11-20" },
  "document.expiring": { kind: "passport", title: "passport", days: "1", expiresOn: "2026-10-22" },
  // A90: marketplace moderation (1473), as private.notify_moderation_decision and console_decide_appeal store them.
  "listing.moderated": {
    title: "Festival Riggers",
    action: "Removed",
    ground: "Terms Violation",
    ruleReference: "Marketplace rules 4.2",
    statement: "The listing asks applicants for a registration fee.",
    appealUntil: "2027-04-19T12:00:00Z",
  },
  "listing_report.decided": {
    title: "Festival Riggers",
    action: "Removed",
    statement: "The listing asks applicants for a registration fee.",
  },
  "moderation_appeal.decided": {
    title: "Festival Riggers",
    outcome: "Upheld",
    statement: "The fee request breaks the marketplace rules.",
  },
};

function kindsOf(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : kindsOf(value, `${prefix}${key}.`),
  );
}

function item(kind: string, args: Record<string, string>): InboxItem {
  return {
    id: "n1",
    createdAt: "2026-10-19T12:00:00Z",
    kind,
    section: "For Your Information",
    read: false,
    actorPersonId: "p1",
    subjectTable: null,
    subjectId: null,
    projectId: null,
    args,
    approval: null,
  };
}

describe("Inbox item copy", () => {
  const labelled = kindsOf(
    (
      ((getMessages("en-US") as unknown as Record<string, Tree>)["platform"] as Tree)[
        "inbox"
      ] as Tree
    )["kinds"] as Tree,
  );

  it("labels every kind of the notification registry (A80), and only those", () => {
    expect([...labelled].sort()).toEqual(NOTIFICATION_KINDS.map((k) => k.kind).sort());
  });

  it("knows the arguments of every labelled kind", () => {
    expect(labelled.length).toBeGreaterThan(20);
    expect(labelled.filter((k) => !(k in ARGS))).toEqual([]);
  });

  for (const locale of locales) {
    it(`describes every kind as a title and summary in ${locale}`, () => {
      const copy = copyFor(locale);
      for (const kind of labelled) {
        const out = describeInboxItem(item(kind, ARGS[kind] ?? {}), copy, {
          org: "demo",
          orgName: "Demo Productions",
          actorName: "Demo Owner",
        });
        const label = copy.t(`inbox.kinds.${kind}`);
        expect(out.summary, kind).not.toBe("");
        expect(out.detail, kind).not.toBe("");
        expect(`${out.summary} ${out.detail}`, kind).not.toMatch(
          /undefined|[{}]|\b[a-z_]{3,}\.[a-z_]{3,}\b/,
        );
        // The email copy, not the bare kind label, describes every kind that has copy.
        if (copy.hasEmail(`kinds.${kind}.subject`)) expect(out.summary, kind).not.toBe(label);
      }
    });
  }

  it("names the actor resolved from the notification when it stored no name", () => {
    const out = describeInboxItem(
      item("survey.opened", { title: "Load-In Pulse" }),
      copyFor("en-US"),
      {
        org: "demo",
        orgName: "Demo Productions",
        actorName: "Demo Producer",
      },
    );
    expect(out).toMatchObject({
      summary: "Survey open: Load-In Pulse",
      detail: "Demo Producer asked for your answers to Load-In Pulse.",
    });
  });

  it("falls back to the label and title when an argument the copy needs is missing", () => {
    const out = describeInboxItem(
      item("shift.assigned", { title: "Stagehand" }),
      copyFor("en-US"),
      {
        org: "demo",
        orgName: "Demo Productions",
        actorName: null,
      },
    );
    expect(out).toMatchObject({ summary: "Shift assigned", detail: "Stagehand" });
  });

  it("links each item to where it opens", () => {
    expect(
      inboxTarget("demo", { subjectTable: "app.feed_posts", kind: "announcement.posted" }),
    ).toBe("/demo/knowledge/feed");
    expect(inboxTarget("demo", { subjectTable: "app.weather_alerts", kind: "weather.alert" })).toBe(
      "/demo/site-ops/weather",
    );
    expect(inboxTarget("demo", { subjectTable: "timesheets", kind: "approval.requested" })).toBe(
      "/demo/crew/timesheets",
    );
    expect(inboxTarget("demo", { subjectTable: null, kind: "billing.read_only" })).toBe(
      "/demo/settings/billing-and-plan",
    );
    expect(inboxTarget("demo", { subjectTable: "unknown", kind: "x.y" })).toBeNull();
  });
});

describe("Inbox keyboard focus (journey 57)", () => {
  it("hands the focus to the next item, or the previous one when the last item leaves", () => {
    expect(neighbourOf(["a", "b", "c"], "a")).toBe("b");
    expect(neighbourOf(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourOf(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourOf(["a"], "a")).toBeNull();
    expect(neighbourOf(["a", "b"], "gone")).toBe("a");
  });
});
