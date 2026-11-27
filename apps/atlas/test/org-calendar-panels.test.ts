import { afterEach, describe, expect, it, vi } from "vitest";
import { CertifiedPayrollPanel } from "@/components/compliance/certified-payroll-panel";
import { AddWarehouseDestinationForm } from "@/components/integrations/warehouse-forms";
import { contributions as a83 } from "@/components/settings/contributions/a83";
import { context, elements, type Settings, viewerDb } from "./org-calendar-support";

/**
 * Two settings panels that date things on the org's own calendar (A71, RRR-116). Each panel is called as
 * the server renders it and its element tree is read, so a panel that goes back to resolved settings (where
 * a member's own unlocked locale.time_zone or payroll.week_start ranks first) or to the UTC date fails here:
 *   - the A83 warehouse panel shows and sets the nightly delivery hour on the org's locale.time_zone row, the
 *     clock the scheduler places it on (private.org_time_zone, 1401);
 *   - the WH-347 panel's default week ending is the last full week of the org's payroll.week_start on each
 *     project's calendar, the week payroll counts overtime over (1399).
 */

const calls = vi.hoisted(() => [] as { key: string; values?: Record<string, unknown> }[]);

vi.mock("@xos/data", () => ({
  getSubscription: () => Promise.resolve({ ok: true, data: { planCode: "enterprise" } }),
}));
vi.mock("@xos/data/warehouse", () => {
  const ok = <T>(data: T) => Promise.resolve({ ok: true, data });
  return {
    listWarehouseProviders: () => ok([{ provider: "S3", available: true }]),
    listWarehouseDestinations: () =>
      ok([
        {
          id: "dst-1",
          displayName: "Nightly lake",
          state: "Active",
          provider: "S3",
          bucketName: "lake",
          fileFormat: "Parquet",
          deliveryHour: 2,
          lastDeliveredAt: null,
          nextDeliveryAt: null,
          includeConfidential: false,
          lastErrorMessage: null,
          credentialStoredAt: null,
        },
      ]),
    listWarehouseDeliveries: () => ok([]),
    listWithheldColumns: () => ok([]),
    listDeadLetters: () => ok([]),
    listInboundSecretConnections: () => ok([]),
  };
});
vi.mock("@xos/integrations", () => ({ isProviderCode: () => true }));
vi.mock("@xos/data/certified-payroll", () => ({
  getCertifiedPayrollHeader: (_db: unknown, projectId: string) =>
    Promise.resolve({
      ok: true,
      data: {
        projectId,
        projectName: projectId,
        contractNumber: "C-1",
        wageDeterminations: "WD-1",
        contractorRole: "Prime contractor",
        businessName: "Northwind",
        businessAddress: "1 Main St",
        projectLocation: "Pier 70",
      },
    }),
}));
vi.mock("@/lib/platform/format", () => ({
  getFormatters: () =>
    Promise.resolve({
      t: (key: string, values?: Record<string, unknown>) => {
        calls.push({ key, ...(values ? { values } : {}) });
        return key;
      },
      dateTime: String,
      number: String,
    }),
}));
vi.mock("@/lib/shell/translate", () => ({
  getTranslate: () => Promise.resolve((key: string) => key),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock("@/lib/docs-site", () => ({ docsUrl: () => "https://docs.example.test" }));
vi.mock("@/lib/env", () => ({ env: () => ({}) }));
// The forms are behind compliance.us_forms (ADR 0033 decision 54); these cases are an org with it on.
vi.mock("@/lib/compliance/flag", () => ({ usComplianceFormsOn: () => Promise.resolve(true) }));
vi.mock("@/lib/compliance/actions", () => ({ saveCertifiedPayrollHeaderAction: () => null }));
vi.mock("@/components/ui", () => ({ InlineAlert: () => null, Button: () => null }));
vi.mock("@/components/operations/action-form", () => ({ ActionForm: () => null }));
vi.mock("@/components/operations/fields", () => ({
  SelectField: () => null,
  TextField: () => null,
}));
vi.mock("@/components/integrations/warehouse-forms", () => ({
  AddWarehouseDestinationForm: () => null,
  InboundSecretForm: () => null,
  RetryDeadLetterForm: () => null,
  WarehouseCredentialForm: () => null,
  WarehouseDestinationActions: () => null,
}));

afterEach(() => {
  calls.length = 0;
  vi.useRealTimers();
});

describe("the warehouse panel's nightly hour (the org's own clock)", () => {
  const found = a83.find((c) => c.order === 30)?.Panel;
  if (!found) throw new Error("A83 has no warehouse panel at order 30");
  const panel = found;

  it("shows and sets the hour in the org's zone, never the member's own", async () => {
    // A member in London edits a New York org's delivery: resolved settings rank London first.
    const db = viewerDb(
      { "locale.time_zone": "America/New_York" },
      { "locale.time_zone": "Europe/London" },
    );
    const tree = await panel({ ctx: context(db, ["reports.schedule.write"]) } as never);
    expect(calls.find((c) => c.key === "warehouse.line")?.values?.["zone"]).toBe(
      "America/New_York",
    );
    const form = elements(tree).find((e) => e.type === AddWarehouseDestinationForm);
    expect(form?.props["timeZone"]).toBe("America/New_York");
  });

  it("is on UTC when the org set no zone, whatever the member set", async () => {
    const db = viewerDb({}, { "locale.time_zone": "Asia/Tokyo" });
    const tree = await panel({ ctx: context(db, ["reports.schedule.write"]) } as never);
    expect(calls.find((c) => c.key === "warehouse.line")?.values?.["zone"]).toBe("UTC");
    const form = elements(tree).find((e) => e.type === AddWarehouseDestinationForm);
    expect(form?.props["timeZone"]).toBe("UTC");
  });
});

describe("the WH-347 panel's default week (the org's payroll week)", () => {
  const projects = [
    { id: "prj-ny", name: "New York", project_key: "NY", time_zone: "America/New_York" },
    { id: "prj-tokyo", name: "Tokyo", project_key: "TK", time_zone: "Asia/Tokyo" },
  ];

  async function weekEndings(now: string, org: Settings, member: Settings) {
    vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
    const db = viewerDb(org, member, { projects });
    const tree = await CertifiedPayrollPanel({ ctx: context(db, ["crew.payroll.export"]) });
    // Each project's issue form, rendered: the week field's default value.
    return Object.fromEntries(
      elements(tree)
        .filter((e) => "header" in e.props && typeof e.type === "function")
        .map((e) => {
          const form = (e.type as (props: Record<string, unknown>) => unknown)(e.props);
          const week = elements(form).find((f) => f.props["name"] === "week");
          return [
            (e.props["header"] as { projectId: string }).projectId,
            week?.props["defaultValue"],
          ];
        }),
    );
  }

  it("ends the last full Sunday-to-Saturday week on each project's calendar", async () => {
    // 21:00 on Saturday 2027-06-19 in New York is already Sunday 06-20 in UTC, and 10:00 Sunday in Tokyo.
    // The org keeps Sunday weeks; the viewer's own Monday start changes nothing. The UTC date gave Sunday
    // 06-13 for both, a Monday week, and New York's week in progress ends that Saturday.
    expect(
      await weekEndings("2027-06-20T01:00:00Z", {}, { "payroll.week_start": "monday" }),
    ).toEqual({
      "prj-ny": "2027-06-12",
      "prj-tokyo": "2027-06-19",
    });
  });

  it("ends on Sunday when the org's payroll week starts on Monday", async () => {
    // 21:00 on Sunday 2027-06-20 in New York is already Monday 06-21 in UTC, and 10:00 Monday in Tokyo:
    // New York's Monday week in progress ends that Sunday, so its last full week ended 06-13; the UTC date
    // gave 06-20 for both.
    expect(
      await weekEndings(
        "2027-06-21T01:00:00Z",
        { "payroll.week_start": "monday" },
        { "payroll.week_start": "sunday" },
      ),
    ).toEqual({ "prj-ny": "2027-06-13", "prj-tokyo": "2027-06-20" });
  });
});
