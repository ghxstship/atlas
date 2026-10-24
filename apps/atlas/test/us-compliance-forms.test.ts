import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";

/**
 * ADR 0033 decision 54 defers the OSHA forms and the WH-347 behind the compliance.us_forms flag, off by default
 * (migration 1593). With the flag off for the org, Settings, Locations and Venues; Settings, Payroll and Time Off; and
 * an incident's record show no panel, the actions save nothing and the forms route answers 404. With it on, all three
 * come back for the same viewer. The flag is read from app.org_feature_flags, as the server reads it per request.
 */
const state = vi.hoisted(() => ({ on: false, ctx: null as unknown }));
const writes = vi.hoisted(() => ({
  establishment: vi.fn(async () => ({ ok: true, data: "est-1" })),
  header: vi.fn(async () => ({ ok: true, data: true })),
  file: vi.fn(async () => ({ ok: false, status: 404 })),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => Object.assign((key: string) => key, { has: () => false }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@/lib/shell/time-zone", () => ({ getOrgWeekStart: async () => 1 }));
vi.mock("@xos/data/certified-payroll", () => ({
  getCertifiedPayrollHeader: async () => ({ ok: true, data: null }),
  saveCertifiedPayrollHeader: writes.header,
}));
vi.mock("@xos/data/osha", () => ({
  OSHA_OUTCOMES: [
    "Death",
    "Days away from work",
    "Job transfer or restriction",
    "Other recordable case",
  ],
  OSHA_CASE_TYPES: ["Injury"],
  getOshaAnnualSummary: async () => ({ ok: true, data: null }),
  getOshaEmploymentEstimate: async () => ({ ok: true, data: null }),
  listOshaCases: async () => ({ ok: true, data: [] }),
  listOshaEstablishments: async () => ({ ok: true, data: [] }),
  createOshaEstablishment: writes.establishment,
  saveOshaAnnualSummary: async () => ({ ok: true, data: true }),
  saveOshaCase: async () => ({ ok: true, data: "case-1" }),
}));
vi.mock("@/lib/compliance/forms", () => ({
  isComplianceForm: (form: string) => ["osha-300", "osha-300a", "osha-301"].includes(form),
  formRequest: (form: string, id: string) => ({ form, id }),
  complianceFormFile: writes.file,
  fileResponse: () => new Response("file"),
}));

const { CertifiedPayrollPanel } = await import("@/components/compliance/certified-payroll-panel");
const { IncidentOshaPanel, OshaEstablishmentsPanel } =
  await import("@/components/compliance/osha-panels");
const { createEstablishmentAction, saveCertifiedPayrollHeaderAction } =
  await import("@/lib/compliance/actions");
const { GET } = await import("@/app/[org]/forms/[form]/[id]/route");

/** A query that answers every chained call with no rows, as the projects list reads. */
function noRows(): unknown {
  const query: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then"
          ? (resolve: (r: unknown) => unknown) => resolve({ data: [], error: null })
          : () => query,
    },
  );
  return query;
}

const rpc = vi.fn(async (fn: string) => ({
  data:
    fn === "org_feature_flags"
      ? [
          { flag_key: "compliance.us_forms", enabled: state.on },
          { flag_key: "imports.google_sheets", enabled: true },
        ]
      : null,
  error: null,
}));

const ctx = {
  org: { id: "org-1", slug: "northwind-live", name: "Northwind Live" },
  capabilities: new Set([
    "crew.payroll.export",
    "safety.incident.read",
    "safety.incident.close",
    "data.restricted.read.medical",
  ]),
  viewer: { db: { rpc, from: () => noRows() }, person: { id: "person-1" } },
} as unknown as OrgContext;

type Element = { type: unknown; props: Record<string, unknown> } | null;
const labelOf = (element: unknown) => (element as Element)?.props["aria-labelledby"];

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function download(form: string): Promise<number> {
  const response = await GET(new Request(`http://localhost/northwind-live/forms/${form}/x`), {
    params: Promise.resolve({ org: "northwind-live", form, id: "x" }),
  } as Parameters<typeof GET>[1]);
  return response.status;
}

describe("the US compliance forms behind compliance.us_forms", () => {
  beforeEach(() => {
    state.ctx = ctx;
    rpc.mockClear();
    writes.establishment.mockClear();
    writes.header.mockClear();
    writes.file.mockClear();
  });

  it("shows no panel while the flag is off for the org", async () => {
    state.on = false;
    expect(await OshaEstablishmentsPanel({ ctx })).toBeNull();
    expect(await CertifiedPayrollPanel({ ctx })).toBeNull();
    expect(await IncidentOshaPanel({ ctx, incidentId: "inc-1", members: [] })).toBeNull();
    expect(rpc).toHaveBeenCalledWith("org_feature_flags", { p_org_id: "org-1" });
  });

  it("shows all three panels once the flag is on", async () => {
    state.on = true;
    expect(labelOf(await OshaEstablishmentsPanel({ ctx }))).toBe("osha-heading");
    expect(labelOf(await CertifiedPayrollPanel({ ctx }))).toBe("wh347-heading");
    expect(labelOf(await IncidentOshaPanel({ ctx, incidentId: "inc-1", members: [] }))).toBe(
      "osha-case-inc-1",
    );
  });

  it("still asks for the capability with the flag on", async () => {
    state.on = true;
    const reader = { ...ctx, capabilities: new Set<string>() } as unknown as OrgContext;
    expect(await OshaEstablishmentsPanel({ ctx: reader })).toBeNull();
    expect(await CertifiedPayrollPanel({ ctx: reader })).toBeNull();
    expect(await IncidentOshaPanel({ ctx: reader, incidentId: "inc-1", members: [] })).toBeNull();
  });

  it("saves nothing from the actions while the flag is off, and saves once it is on", async () => {
    const establishment = form({
      org: "northwind-live",
      name: "Northwind Shop",
      street: "",
      city: "Miami",
      state: "FL",
      zip: "",
      naics: "",
      industry: "",
    });
    const header = form({
      org: "northwind-live",
      project: "0190f1a2-0000-7000-8000-000000000001",
      contractNumber: "GS-07P-27-0001",
      wageDeterminations: "FL20270001 Mod 2",
      contractorRole: "Prime contractor",
      businessName: "Northwind Live LLC",
      businessAddress: "100 Harbor Way, Miami, FL 33132",
      projectLocation: "Miami-Dade County, FL",
    });
    state.on = false;
    expect(await createEstablishmentAction({}, establishment)).toEqual({ error: "notFound" });
    expect(await saveCertifiedPayrollHeaderAction({}, header)).toEqual({ error: "notFound" });
    expect(writes.establishment).not.toHaveBeenCalled();
    expect(writes.header).not.toHaveBeenCalled();
    state.on = true;
    expect(await createEstablishmentAction({}, establishment)).toMatchObject({ ok: true });
    expect(writes.establishment).toHaveBeenCalledOnce();
  });

  it("answers 404 for every form while the flag is off, and reads the form once it is on", async () => {
    state.on = false;
    expect(await download("osha-300a")).toBe(404);
    expect(writes.file).not.toHaveBeenCalled();
    state.on = true;
    await download("osha-300a");
    expect(writes.file).toHaveBeenCalledOnce();
  });
});
