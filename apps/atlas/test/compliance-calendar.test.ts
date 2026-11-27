import type * as Osha from "@xos/data/osha";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OshaEstablishmentsPanel } from "@/components/compliance/osha-panels";
import { recordOshaCaseAction, saveOshaSummaryAction } from "@/lib/compliance/actions";
import { complianceFormFile } from "@/lib/compliance/forms";
import type { OrgContext } from "@/lib/shell/context";
import { context, elements, type Settings, viewerDb } from "./org-calendar-support";

/**
 * The compliance forms date things on the org's calendar (locale.time_zone at the org), never the UTC date
 * (A71, RRR-116; A82's OSHA records and WH-347, ADR 0041). Every case runs at 22:00 on New Year's Eve in New
 * York, already 2027 in UTC, for an org on New York's calendar whose member keeps Tokyo's.
 */

const seen = vi.hoisted(() => ({
  summary: [] as Record<string, unknown>[],
  case: [] as Record<string, unknown>[],
  caseYears: [] as number[],
  wh347: [] as Record<string, unknown>[],
  ctx: null as OrgContext | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en-US"),
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock("@/lib/env", () => ({ env: () => ({ ATLAS_SITE_URL: "https://atlas.example.test" }) }));
// The forms are behind compliance.us_forms (ADR 0033 decision 54); these cases are an org with it on.
vi.mock("@/lib/compliance/flag", () => ({ usComplianceFormsOn: () => Promise.resolve(true) }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: () => Promise.resolve(seen.ctx) }));
vi.mock("@/components/ui", () => ({ Button: () => null, DownloadLink: () => null }));
vi.mock("@/components/operations/action-form", () => ({ ActionForm: () => null }));
vi.mock("@/components/operations/fields", () => ({
  SelectField: () => null,
  TextAreaField: () => null,
  TextField: () => null,
}));
vi.mock("@xos/data/osha", async (importOriginal) => {
  const ok = <T>(data: T) => Promise.resolve({ ok: true, data });
  return {
    ...(await importOriginal<typeof Osha>()),
    saveOshaAnnualSummary: (_db: unknown, input: Record<string, unknown>) => {
      seen.summary.push(input);
      return ok(true);
    },
    saveOshaCase: (_db: unknown, input: Record<string, unknown>) => {
      seen.case.push(input);
      return ok({ id: "case-1" });
    },
    getOshaEstablishment: (_db: unknown, id: string) => ok({ id, name: "Pier 70" }),
    listOshaCases: (_db: unknown, filter: { year: number }) => {
      seen.caseYears.push(filter.year);
      return ok([]);
    },
    listOshaEstablishments: () => ok([{ id: "est-1", name: "Pier 70", locality: null }]),
  };
});
vi.mock("@xos/data/certified-payroll", () => ({
  saveCertifiedPayrollHeader: () => Promise.resolve({ ok: true, data: true }),
  certifiedPayrollCsv: () => "",
  issueCertifiedPayroll: () =>
    Promise.resolve({
      ok: true,
      data: { payrollNumber: 3, weekEnding: "2026-12-26", header: { projectName: "Pier 70" } },
    }),
  certifiedPayrollModel: (_payroll: unknown, ctx: Record<string, unknown>) => {
    seen.wh347.push(ctx);
    return {};
  },
}));
vi.mock("@xos/data/documents/render", () => ({
  renderDocumentPdf: () => Promise.resolve(new Uint8Array()),
}));
vi.mock("@xos/data/documents/generate", () => ({
  loadDocumentBrand: () => Promise.resolve(null),
  watermarkText: () => "Downloaded by alice@example.test",
}));

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const EST_ID = "00000000-0000-4000-8000-000000000002";
const INCIDENT_ID = "00000000-0000-4000-8000-000000000003";

function orgOn(org: Settings, capabilities: string[] = []): OrgContext {
  seen.ctx = context(viewerDb(org, { "locale.time_zone": "Asia/Tokyo" }), capabilities);
  return seen.ctx;
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({ org: "northwind", ...values })) {
    data.set(key, value);
  }
  return data;
}

beforeEach(() => {
  // 22:00 on Thursday 2026-12-31 in New York; 2027-01-01 in UTC and 12:00 on New Year's Day in Tokyo.
  vi.useFakeTimers({ now: new Date("2027-01-01T03:00:00Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  seen.summary.length = 0;
  seen.case.length = 0;
  seen.caseYears.length = 0;
  seen.wh347.length = 0;
});

const NEW_YORK = { "locale.time_zone": "America/New_York" };

describe("OSHA Form 300A certification", () => {
  it("is certified on the org's date", async () => {
    orgOn(NEW_YORK);
    const state = await saveOshaSummaryAction(
      {},
      form({
        establishment: EST_ID,
        year: "2026",
        employees: "12",
        hours: "24000",
        title: "Owner",
        phone: "",
        certify: "on",
      }),
    );
    expect(state).toEqual({ ok: true, result: { year: "2026" } });
    expect(seen.summary[0]?.["certifiedOn"]).toBe("2026-12-31");
  });

  it("is on UTC's date only when the org set no zone, whatever the member set", async () => {
    orgOn({});
    await saveOshaSummaryAction(
      {},
      form({
        establishment: EST_ID,
        year: "2026",
        employees: "",
        hours: "",
        title: "",
        phone: "",
        certify: "on",
      }),
    );
    expect(seen.summary[0]?.["certifiedOn"]).toBe("2027-01-01");
  });
});

describe("OSHA Form 301 completion", () => {
  it("is completed on the org's date", async () => {
    orgOn(NEW_YORK);
    const empty = Object.fromEntries(
      [
        "employeeName",
        "employeeStreet",
        "employeeCity",
        "employeeState",
        "employeeZip",
        "dateOfBirth",
        "dateHired",
        "professional",
        "facility",
        "facilityStreet",
        "facilityCity",
        "facilityState",
        "facilityZip",
        "workBegan",
        "eventTime",
        "activityBefore",
        "whatHappened",
        "injuryDetail",
        "harmfulObject",
        "diedOn",
        "completedTitle",
        "completedPhone",
        "daysAway",
        "daysRestricted",
      ].map((key) => [key, ""]),
    );
    const state = await recordOshaCaseAction(
      {},
      form({
        ...empty,
        incident: INCIDENT_ID,
        establishment: EST_ID,
        person: ORG_ID,
        jobTitle: "Rigger",
        injuryDate: "2026-12-30",
        eventLocation: "Stage left",
        description: "Strained back lifting a truss",
        outcome: "Other recordable case",
        caseType: "Injury",
      }),
    );
    expect(state).toEqual({ ok: true });
    expect(seen.case[0]?.["completed_on"]).toBe("2026-12-31");
  });
});

describe("the compliance form files", () => {
  it("defaults an OSHA log to the org's year", async () => {
    const ctx = orgOn(NEW_YORK);
    await complianceFormFile(ctx, { form: "osha-300", id: EST_ID, format: "csv", paper: "letter" });
    expect(seen.caseYears).toEqual([2026]);
  });

  it("dates the WH-347's statement on the org's calendar", async () => {
    const ctx = orgOn(NEW_YORK);
    const file = await complianceFormFile(ctx, {
      form: "certified-payroll",
      id: EST_ID,
      format: "pdf",
      paper: "letter",
      weekEnding: "2026-12-26",
    });
    expect(file.ok).toBe(true);
    expect(seen.wh347[0]?.["timeZone"]).toBe("America/New_York");
  });
});

describe("the OSHA establishments panel", () => {
  it("lists this year and the last on the org's calendar", async () => {
    const tree = await OshaEstablishmentsPanel({ ctx: orgOn(NEW_YORK, ["safety.incident.read"]) });
    const years = elements(tree)
      .filter((e) => "establishment" in e.props)
      .map((e) => e.props["year"]);
    expect(years).toEqual([2026, 2025]);
  });
});
