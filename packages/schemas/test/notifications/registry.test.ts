import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_DRIFT_TEST,
  NOTIFICATION_KIND_SEED_MIGRATION,
  NOTIFICATION_REGISTRY_MODULE,
  NotificationRegistryError,
  notificationKind,
  parseNotificationRegistry,
  preferenceMatrix,
  renderNotificationDriftTest,
  renderNotificationRegistryModule,
  renderNotificationSeedSql,
} from "../../src/notifications/index.ts";
import {
  NOTIFICATION_KINDS_YAML_PATH,
  loadNotificationRegistry,
} from "../../src/notifications/load.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(path, "utf8");
const registry = loadNotificationRegistry();
const yamlText = read(NOTIFICATION_KINDS_YAML_PATH);

describe("notification kind registry (Section 3.15, A65-021)", () => {
  it("declares every channel, category and kind once", () => {
    expect(registry.channels.map((c) => [c.code, c.enabledByDefault])).toEqual([
      ["In App", true],
      ["Email", true],
      ["SMS", false],
      ["Push", true],
    ]);
    expect(registry.categories.map((c) => c.code)).toEqual([
      "mentions",
      "assignments",
      "approvals",
      "comments",
      "schedule",
      "finance",
      "safety",
      "account",
      "reports",
      "imports",
      "automations",
      "messages",
      "feed",
      "opportunities",
      "expiry_reminders",
    ]);
    expect(registry.categories.filter((c) => c.urgent).map((c) => c.code)).toEqual([
      "safety",
      "account",
    ]);
    // 43 kinds (A79, A91, A99 among them), plus the three marketplace moderation kinds of A90 (1473) and the four
    // reported content kinds of ADR 0033 decision 57 (1630), the three crew roster kinds of R4 (2642), and R5's
    // project facts and names lock kinds (2655, 2656), R6a's account.work_details_moved (2664), and R7's four
    // allocation kinds (2698).
    expect(registry.kinds).toHaveLength(64);
    expect(notificationKind("approval.requested")).toMatchObject({
      category: "approvals",
      emailTemplate: "notification",
      pushCategory: "approval_request",
      copy: {
        subject: "kinds.approval.requested.subject",
        body: "kinds.approval.requested.body",
      },
    });
    expect(notificationKind("export.ready")?.emailTemplate).toBe("export_ready");
    // ADR 0033 decision 35: a short, reviewable bypass list; mandatory or urgent categories alone never bypass.
    // ADR 0033 decision 62 adds a new shift within 12 hours, security changes (with a recovery code used) and
    // emergency access.
    expect(
      registry.kinds
        .filter((k) => k.quietHoursBypass !== null)
        .map((k) => [k.kind, k.quietHoursBypass?.startsWithinHours]),
    ).toEqual([
      ["shift.assigned", 12],
      ["shift.changed", 12],
      ["incident.reported", null],
      ["occupancy.threshold", null],
      ["weather.alert", null],
      ["account.security_changed", null],
      ["account.recovery_code_used", null],
      ["access.break_glass_started", null],
    ]);
    // Billing notices wait until morning, although the account category is urgent.
    expect(
      registry.kinds.filter((k) => k.kind.startsWith("billing.")).map((k) => k.quietHoursBypass),
    ).toEqual([null, null, null, null]);
    // ADR 0033 decision 77: a delivered report reaches the Inbox and a push, never a second email.
    expect(notificationKind("report.delivered")?.channels).toEqual(["In App", "Push"]);
    expect(notificationKind("no.such_kind")).toBeUndefined();
  });

  it("keeps the seed migration, its drift test and the generated module equal to the YAML", async () => {
    expect(read(`${repoRoot}${NOTIFICATION_KIND_SEED_MIGRATION}`)).toBe(
      renderNotificationSeedSql(registry),
    );
    expect(read(`${repoRoot}${NOTIFICATION_KIND_DRIFT_TEST}`)).toBe(
      renderNotificationDriftTest(registry),
    );
    const modulePath = `${packageRoot}${NOTIFICATION_REGISTRY_MODULE}`;
    const options = (await resolveConfig(modulePath)) ?? {};
    expect(read(modulePath)).toBe(
      await format(renderNotificationRegistryModule(registry), {
        ...options,
        filepath: modulePath,
      }),
    );
    expect(NOTIFICATION_KINDS).toEqual(registry.kinds);
    expect(NOTIFICATION_CATEGORIES).toEqual(registry.categories);
  });

  it("seeds every kind on each of its channels, with the email template only on Email", () => {
    const sql = renderNotificationSeedSql(registry);
    expect(sql).toContain(
      "('approval.requested', 'Email'::app.notification_channel, 'approvals', 'notification')",
    );
    expect(sql).toContain(
      "('approval.requested', 'Push'::app.notification_channel, 'approvals', null)",
    );
    // Only what the registry alone writes is deleted: the bypass list, replaced as a set, and the channel rows of a
    // kind that names fewer channels. Kinds are never deleted.
    expect(sql.match(/\bdelete\b/g)).toHaveLength(2);
    expect(sql).toContain(
      "delete from private.notification_templates\nwhere (kind = 'report.delivered' and channel not in ('In App', 'Push'))\n   or (kind = 'opportunity.matched' and channel not in ('In App', 'Email', 'Push'));",
    );
    const drift = renderNotificationDriftTest(registry);
    expect(drift).toContain("select plan(5);");
    expect(drift).toContain("('shift.changed', interval '12 hours')");
    expect(sql).toContain("delete from private.notification_quiet_hours_bypass");
    expect(drift).toContain("('report.delivered', 'Push', 'reports', null::text)");
    expect(drift).not.toContain("('report.delivered', 'Email'");
  });

  it("builds the preference matrix in display order with the kinds of each category", () => {
    const matrix = preferenceMatrix(registry);
    expect(matrix[0]).toMatchObject({ code: "mentions", kinds: ["mention.created"] });
    expect(matrix.find((r) => r.code === "finance")?.kinds).toEqual([
      "invoice.approved",
      "invoice.submitted",
      "invoice.scheduled",
      "invoice.paid",
    ]);
    expect(matrix.map((r) => r.order)).toEqual(
      [...matrix.map((r) => r.order)].sort((a, b) => a - b),
    );
  });

  it("refuses a malformed registry and names every broken rule", () => {
    const broken = yamlText
      .replace(
        "  - kind: comment.created\n    category: comments\n    emitted_by:\n      # 1600 redefines 0580's emitter so a comment on a record carries the record's key.\n      - emitter: supabase/migrations/1600_record_keys_in_notifications.sql#private.notify_comment_subscribers\n        test: supabase/tests/1600_record_keys_in_notifications.test.sql\n",
        "",
      )
      .replace(
        "  - kind: shift.changed\n    category: schedule\n",
        "  - kind: shift.assigned\n    category: schedule\n",
      )
      .replace(
        "  - kind: weather.alert\n    category: safety\n",
        "  - kind: weather.alert\n    category: weather\n    channels: [Email]\n    push_category: alert\n",
      );
    let error: unknown;
    try {
      parseNotificationRegistry(broken);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NotificationRegistryError);
    const issues = (error as NotificationRegistryError).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        "kind shift.assigned is declared twice",
        "kind weather.alert: unknown category weather",
        "kind weather.alert: every kind is shown in the app (In App)",
        "kind weather.alert: a push category needs the Push channel",
        "kind weather.alert: only SMS and Push keep quiet hours, so a bypass needs one of them",
        "category comments has no kind",
      ]),
    );
    expect(() => parseNotificationRegistry("version: 2\n")).toThrow(NotificationRegistryError);
    expect(() =>
      parseNotificationRegistry(yamlText.replace("  - code: notification\n", "  - code: notice\n")),
    ).toThrow(/the notification email template is required/);
  });
});
