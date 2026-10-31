import { getMessages, locales } from "@xos/i18n";
import type { InboxItem } from "@xos/data/inbox";
import { NOTIFICATION_KINDS } from "@xos/schemas/notifications";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { describeInboxItem, inboxTarget, type InboxCopy } from "../lib/inbox/describe";
import { neighbourOf, neighbourOutside, selectItems } from "../lib/inbox/focus";

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
  // R6a's one-time move (2664), as private.move_profile_work_details stores it.
  "account.work_details_moved": { moved: "both" },
  "announcement.posted": { title: "Wristband Change Friday" },
  "approval.requested": { title: "Purchase Order 41", actorName: "Demo Producer" },
  "approval.decided": { title: "Purchase Order 41", actorName: "Demo Admin", decision: "approved" },
  // Notifications about a record carry its key (1600).
  "assignment.created": { title: "NWS-12 Production Meeting", recordKey: "NWS-12" },
  // A91's automation kinds (1481), as app.send_automation_notice, the failure notice and the pause store them; a
  // notice about a record carries its key (1600).
  "automation.notice": {
    automationName: "Pick up tasks",
    title: "New task: Call the venue",
    body: "Call the venue needs a look.",
    recordKey: "NWS-14",
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
  "comment.created": { title: "NWS-12 Production Meeting", recordKey: "NWS-12" },
  // P5: app.request_credential_photos (2822) names the org and the Gateway page the item opens.
  "credential_photo.requested": {
    orgName: "Demo Productions",
    gatewayPath: "/profile/badge-photos",
  },
  "event.invited": { title: "Show Day Safety Briefing", startsAt: "2026-10-21T09:00:00+00:00" },
  "export.ready": { title: "Records export" },
  "help_request.assigned": { title: "Dock tablet will not sign in", team: "Site IT Desk" },
  // 2051: a committed import's rows, as private.notify stores the numbers (the Inbox reads them as text).
  "import.finished": {
    title: "Crew import",
    stage: "committed",
    written: "12",
    refused: "1",
    skipped: "0",
  },
  "incident.reported": { title: "NWS-32 Slip at dock" },
  "invoice.approved": { title: "INV-0042" },
  "invoice.submitted": { title: "INV-0042" },
  "invoice.scheduled": { title: "INV-0042" },
  "invoice.paid": { title: "INV-0042" },
  "mention.created": { title: "NWS-12 Production Meeting", recordKey: "NWS-12" },
  "message.received": { kind: "Text" },
  "occupancy.threshold": { title: "Main Gate", percent: "90", count: "450", permitted_load: "500" },
  "recognition.received": { title: "Re-rigged the stage left truss in record time." },
  "report.delivered": { title: "Weekly labor" },
  // R4: the crew roster (2642), as private.roster_notification_args stores them.
  "roster_entry.invited": {
    personName: "Kai Morgan",
    partyName: "Bayside Audio",
    projectName: "Northwind Summer Series",
    orgName: "Northwind Live",
  },
  "roster_entry.returned": {
    personName: "Kai Morgan",
    partyName: "Bayside Audio",
    projectName: "Northwind Summer Series",
    orgName: "Northwind Live",
    reason: "Add the arrival window.",
  },
  "roster_entry.declined": {
    personName: "Kai Morgan",
    partyName: "Bayside Audio",
    projectName: "Northwind Summer Series",
    orgName: "Northwind Live",
  },
  // R5: project facts entered for the person (2655) and an engagement's names lock (2656).
  "roster_entry.project_facts_entered": {
    kind: "travel",
    actorName: "Riley Chen",
    companyName: "Bayside Audio",
    projectName: "Northwind Summer Series",
  },
  "engagement.roster_lock_changed": {
    projectName: "Northwind Summer Series",
    locksAt: "2027-03-01T17:00:00Z",
  },
  // R7: advance allocations (2693, 2694), as private.allocation_notification_args stores them.
  "allocation.decided": {
    personName: "Kai Morgan",
    partyName: "Bayside Audio",
    projectName: "Northwind Summer Series",
    orgName: "Northwind Live",
    kind: "asset",
    itemName: "Two-way radios",
    quantity: "2",
    decision: "approved",
  },
  "allocation.assigned": {
    personName: "Kai Morgan",
    partyName: "Bayside Audio",
    projectName: "Northwind Summer Series",
    orgName: "Northwind Live",
    kind: "asset",
    itemName: "Two-way radios",
    quantity: "2",
  },
  "allocation.issued": {
    personName: "Kai Morgan",
    partyName: "Bayside Audio",
    projectName: "Northwind Summer Series",
    orgName: "Northwind Live",
    kind: "asset",
    itemName: "Two-way radios",
    quantity: "2",
  },
  "allocation.withdrawn": {
    personName: "Kai Morgan",
    partyName: "Bayside Audio",
    projectName: "Northwind Summer Series",
    orgName: "Northwind Live",
    kind: "asset",
    itemName: "Two-way radios",
    quantity: "2",
    cause: "engagement_ended",
  },
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
  // Reported content (ADR 0033 decision 57, 1630).
  "content_report.filed": {
    subject: "message",
    reason: "harassment",
    dueAt: "2026-10-24T12:00:00Z",
  },
  "content_report.overdue": { subject: "post", openReports: "2", dueAt: "2026-10-24T12:00:00Z" },
  "content_report.decided": {
    subject: "comment",
    action: "Removed",
    statement: "The comment insults a crew member.",
  },
  "content.removed": {
    subject: "post",
    ground: "Terms Violation",
    ruleReference: "Acceptable Use Policy 1",
    statement: "The post insults crew members who arrived late.",
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

  it("says which sign-in setting changed, in every locale (2050)", () => {
    const changes = [
      "password",
      "password_set",
      "password_removed",
      "email",
      "phone",
      "factor_added",
      "factor_removed",
      "passkey_added",
      "passkey_removed",
      "recovery_codes",
    ];
    for (const locale of locales) {
      const copy = copyFor(locale);
      // The sentence of a change the copy does not know.
      const generic = copy.email("kinds.account.security_changed.body", { change: "unknown" });
      const details = changes.map(
        (change) =>
          describeInboxItem(
            item("account.security_changed", { change, factorType: "totp" }),
            copy,
            { org: "demo", orgName: "Demo Productions", actorName: null },
          ).detail,
      );
      for (const detail of details) expect(detail, locale).not.toBe(generic);
      expect(new Set(details).size, locale).toBe(changes.length);
    }
    const out = describeInboxItem(
      item("account.security_changed", { change: "factor_added", factorType: "webauthn" }),
      copyFor("en-US"),
      { org: "demo", orgName: "Demo Productions", actorName: null },
    );
    expect(out).toEqual({
      summary: "Your account security changed",
      detail:
        "A security key or passkey was added to your two-step verification. If this was not you, reset your password now.",
      href: "/demo/me/security",
    });
  });

  it("tells a validated import from a committed one, and opens it in the wizard (2051)", () => {
    const validated = describeInboxItem(
      {
        ...item("import.finished", {
          title: "Crew import",
          stage: "validated",
          written: "12",
          refused: "1",
          skipped: "2",
        }),
        subjectTable: "app.import_jobs",
        subjectId: "0192b0c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
      },
      copyFor("en-US"),
      { org: "demo", orgName: "Demo Productions", actorName: null },
    );
    expect(validated).toEqual({
      summary: "Import ready to review: Crew import",
      detail:
        "Crew import is checked: 12 rows are ready to write, 1 needs fixing and 2 were skipped. Review it, then commit the import.",
      href: "/demo/import?import=0192b0c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    });
    const committed = describeInboxItem(
      item("import.finished", ARGS["import.finished"] ?? {}),
      copyFor("es-US"),
      { org: "demo", orgName: "Demo Productions", actorName: null },
    );
    expect(committed.summary).toBe("Importación terminada: Crew import");
    expect(committed.detail).toBe(
      "Crew import terminó: 12 filas escritas, 1 rechazada y 0 omitidas.",
    );
    expect(inboxTarget("demo", { subjectTable: "app.import_jobs", kind: "import.finished" })).toBe(
      "/demo/import",
    );
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
    expect(inboxTarget("demo", { subjectTable: "app.shifts", kind: "shift.changed" })).toBe(
      "/demo/crew/shifts",
    );
    expect(inboxTarget("demo", { subjectTable: "app.shifts", kind: "shift.assigned" })).toBe(
      "/demo/crew/shifts",
    );
    expect(inboxTarget("demo", { subjectTable: "app.records", kind: "assignment.created" })).toBe(
      "/demo/my-work",
    );
    expect(inboxTarget("demo", { subjectTable: "unknown", kind: "x.y" })).toBeNull();
  });

  it("opens a delivered report in Saved reports, with the report's panel open (ADR 0033 decision 77)", () => {
    expect(
      inboxTarget("demo", {
        subjectTable: "app.report_definitions",
        subjectId: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
        kind: "report.delivered",
      }),
    ).toBe("/demo/reports/saved-reports?peek=0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f");
    expect(
      inboxTarget("demo", { subjectTable: "app.report_definitions", kind: "report.delivered" }),
    ).toBe("/demo/reports/saved-reports");
  });

  it("opens a record itself when the item carries its key, and only an assignment in My Work otherwise", () => {
    const keyed = { recordKey: "NWL-42" };
    for (const kind of ["comment.created", "mention.created", "assignment.created"]) {
      expect(inboxTarget("demo", { subjectTable: "app.records", kind, args: keyed })).toBe(
        "/demo/r/NWL-42",
      );
    }
    // An automation notice names its subject as the domain event does (records).
    expect(
      inboxTarget("demo", { subjectTable: "records", kind: "automation.notice", args: keyed }),
    ).toBe("/demo/r/NWL-42");
    expect(inboxTarget("demo", { subjectTable: "records", kind: "automation.notice" })).toBeNull();
    // My Work lists the records a person is assigned to: a comment or a mention on another record is not there.
    expect(
      inboxTarget("demo", { subjectTable: "app.records", kind: "comment.created" }),
    ).toBeNull();
    expect(
      inboxTarget("demo", { subjectTable: "app.records", kind: "mention.created", args: {} }),
    ).toBeNull();
  });

  it("links every record item to the record its emitter keyed (1600)", () => {
    const subjects: Readonly<Record<string, string>> = {
      "assignment.created": "app.records",
      "comment.created": "app.records",
      "mention.created": "app.records",
      "automation.notice": "records",
    };
    for (const [kind, subjectTable] of Object.entries(subjects)) {
      const args = ARGS[kind] ?? {};
      const out = describeInboxItem({ ...item(kind, args), subjectTable }, copyFor("en-US"), {
        org: "demo",
        orgName: "Demo Productions",
        actorName: "Demo Owner",
      });
      expect(out.href, kind).toBe(`/demo/r/${args["recordKey"]}`);
    }
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

describe("Inbox selection (Section 11.2: X selects)", () => {
  const ids = ["a", "b", "c", "d"];

  it("toggles with X and selects a range from the anchor with Shift+X", () => {
    let state = selectItems(ids, new Set(), null, "b", false);
    expect([...state.selected]).toEqual(["b"]);
    state = selectItems(ids, state.selected, state.anchor, "d", true);
    expect([...state.selected].sort()).toEqual(["b", "c", "d"]);
    state = selectItems(ids, state.selected, state.anchor, "c", false);
    expect([...state.selected].sort()).toEqual(["b", "d"]);
    expect(state.anchor).toBe("c");
    // Without an anchor Shift+X toggles the one item.
    expect([...selectItems(ids, new Set(), null, "a", true).selected]).toEqual(["a"]);
  });

  it("hands the focus past every item that leaves together", () => {
    expect(neighbourOutside(ids, "b", new Set(["b", "c"]))).toBe("d");
    expect(neighbourOutside(ids, "c", new Set(["a", "c", "d"]))).toBe("b");
    expect(neighbourOutside(ids, "a", new Set(["b"]))).toBe("a");
    expect(neighbourOutside(ids, "a", new Set(ids))).toBeNull();
  });
});
