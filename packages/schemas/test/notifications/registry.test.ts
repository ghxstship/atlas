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
      "messages",
      "feed",
    ]);
    expect(registry.categories.filter((c) => c.urgent).map((c) => c.code)).toEqual([
      "safety",
      "account",
    ]);
    expect(registry.kinds).toHaveLength(28);
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
    expect(sql).not.toMatch(/\bdelete\b/);
    const drift = renderNotificationDriftTest(registry);
    expect(drift).toContain("select plan(4);");
    expect(drift).toContain("('report.delivered', 'SMS', 'reports', null::text)");
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
      .replace("  - kind: comment.created\n    category: comments\n", "")
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
        "category comments has no kind",
      ]),
    );
    expect(() => parseNotificationRegistry("version: 2\n")).toThrow(NotificationRegistryError);
    expect(() =>
      parseNotificationRegistry(yamlText.replace("  - code: notification\n", "  - code: notice\n")),
    ).toThrow(/the notification email template is required/);
  });
});
