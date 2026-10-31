import type { Audience, Row } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { access, type CompassIdentity } from "../src/domain/access";
import { searchLocal } from "../src/domain/search";
import { searchDocs, type SearchDocsInput } from "../src/domain/searchDocs";

/**
 * What Compass Today searches (A126, RRR-171): each kind reads the rows of the screen it opens, with that
 * screen's filters, so a result never lands on a page that does not list it.
 */

const now = Date.UTC(2026, 9, 27, 12, 0, 0);
const hour = 3_600_000;
const iso = (offset: number) => new Date(now + offset).toISOString();

const field: CompassIdentity = {
  personId: "p1",
  displayName: "Ana Ruiz",
  audience: "field",
  capabilities: ["safety.incident.write"],
  membershipId: "m1",
  engagements: [],
};

function external(audience: Audience, projectId = "proj-1"): CompassIdentity {
  return {
    personId: "p2",
    displayName: "Vendor Person",
    audience,
    capabilities: [],
    membershipId: null,
    engagements: [
      {
        id: "e1",
        orgId: "o1",
        orgName: "Northwind",
        projectId,
        projectName: "Pier Show",
        roleType: audience,
        state: "Active",
      },
    ],
  };
}

const tables: Readonly<Record<string, readonly Row[]>> = {
  projects: [
    { id: "proj-1", name: "Pier Show" },
    { id: "proj-2", name: "Harbor Fest" },
  ],
  shifts: [
    {
      id: "s-next",
      project_id: "proj-1",
      membership_id: "m1",
      starts_at: iso(2 * hour),
      ends_at: iso(10 * hour),
      shift_state: "Accepted",
      job_title: "Rigger",
    },
    {
      id: "s-over",
      project_id: "proj-1",
      membership_id: "m1",
      starts_at: iso(-30 * hour),
      ends_at: iso(-20 * hour),
      shift_state: "Accepted",
      job_title: "Rigger",
    },
    {
      id: "s-draft",
      project_id: "proj-1",
      membership_id: "m1",
      starts_at: iso(30 * hour),
      ends_at: iso(40 * hour),
      shift_state: "Draft",
      job_title: "Rigger",
    },
    {
      id: "s-other-project",
      project_id: "proj-2",
      membership_id: "m1",
      starts_at: iso(30 * hour),
      ends_at: iso(40 * hour),
      shift_state: "Accepted",
      job_title: "Rigger",
    },
    {
      id: "s-colleague",
      project_id: "proj-1",
      membership_id: "m9",
      starts_at: iso(2 * hour),
      ends_at: iso(10 * hour),
      shift_state: "Accepted",
      job_title: "Rigger",
    },
  ],
  sops: [
    {
      id: "sop-published",
      code: "SOP-001",
      title: "Working at height",
      body: "Harness checks before every climb.",
      published_at: iso(-100 * hour),
    },
    {
      id: "sop-draft",
      code: "SOP-034",
      title: "Height rescue plan",
      body: "Standard Library draft.",
      published_at: null,
    },
  ],
  canon_emergency_codes: [
    { id: "CODE_RED", label: "Code Red", emergency: "Fire", swatch: "ecode-red", sort_order: 1 },
  ],
  emergency_codes: [],
  radio_channels: [
    { id: "ch-1", project_id: "proj-1", channel_number: 4, name: "Rigging" },
    { id: "ch-2", project_id: "proj-2", channel_number: 5, name: "Rigging Harbor" },
  ],
  incidents: [
    { id: "i-1", project_id: "proj-1", title: "Rigging fault", incident_number: 12 },
    { id: "i-2", project_id: "proj-2", title: "Rigging slip", incident_number: 13 },
  ],
  kiosk_roster: [
    { id: "m2", display_name: "Bo Rigger" },
    { id: "m3", display_name: null },
  ],
  shared_records: [
    { id: "r-approval", project_id: "proj-1", record_kind: "Approval", title: "Rigging plot" },
    { id: "r-task", project_id: "proj-1", record_kind: "Task", title: "Rigging walk" },
    { id: "r-elsewhere", project_id: "proj-2", record_kind: "Approval", title: "Rigging loads" },
  ],
  purchase_orders: [
    {
      id: "po-1",
      project_id: "proj-1",
      po_number: 42,
      org_name: "Northwind",
      project_name: "Pier Show",
    },
  ],
  onboarding_items: [
    { id: "ob-1", engagement_id: "e1", name: "Rigging card", satisfied: false },
    { id: "ob-2", engagement_id: "e1", name: "Rigging waiver", satisfied: true },
  ],
  deliverables: [
    { id: "d-1", engagement_id: "e1", title: "Rigging drawings", deliverable_state: "Open" },
    { id: "d-2", engagement_id: "e1", title: "Rigging notes", deliverable_state: "Accepted" },
  ],
};

function input(
  identity: CompassIdentity,
  overrides: Partial<SearchDocsInput> = {},
): SearchDocsInput {
  return {
    identity,
    projectId: "proj-1",
    rows: (table) => tables[table] ?? [],
    allowed: (feature) => access(identity, feature, "proj-1").allowed,
    t: (key, values) => (values ? `${key} ${Object.values(values).join(" ")}` : key),
    shiftTitle: (s) => s.job_title ?? "",
    shiftWhen: (s) => s.starts_at,
    now,
    ...overrides,
  };
}

const ids = (docs: readonly { readonly id: string }[]) => docs.map((d) => d.id);
const found = (
  identity: CompassIdentity,
  query: string,
  overrides: Partial<SearchDocsInput> = {},
) => ids(searchLocal(searchDocs(input(identity, overrides)), query, { now, perKind: 50 }));

describe("searchDocs", () => {
  it("finds only published SOPs, as Reference lists them", () => {
    const hits = found(field, "height");
    expect(hits).toContain("sop-published");
    expect(hits).not.toContain("sop-draft");
    expect(found(field, "SOP-034")).not.toContain("sop-draft");
  });

  it("finds the person's own shifts on the chosen project that My shifts lists", () => {
    const shifts = searchDocs(input(field)).filter((d) => d.kind === "shift");
    expect(ids(shifts)).toEqual(["s-next"]);
    expect(shifts[0]).toMatchObject({ title: "Rigger", body: "Pier Show", href: "/schedule" });
    expect(found(field, "rigger")).toContain("s-next");
  });

  it("names an untitled shift by the schedule's heading", () => {
    const docs = searchDocs(input(field, { shiftTitle: () => "" }));
    expect(docs.find((d) => d.id === "s-next")?.title).toBe("compass.schedule.myShifts");
  });

  it("falls back to the canon emergency codes for an org that never adopted", () => {
    const code = searchDocs(input(field)).find((d) => d.href === "/reference/emergency-codes");
    expect(code).toMatchObject({ id: "CODE_RED", title: "Code Red", body: "Fire" });
    expect(found(field, "fire")).toContain("CODE_RED");
  });

  it("uses the org's own emergency codes once it holds them", () => {
    const rows = (table: string): readonly Row[] =>
      table === "emergency_codes"
        ? [
            {
              id: "ec-1",
              org_id: "o1",
              code: "CODE_RED",
              label: "Fire alarm",
              emergency: "Evacuate",
              sort_order: 1,
            },
          ]
        : (tables[table] ?? []);
    const codes = searchDocs(input(field, { rows })).filter(
      (d) => d.href === "/reference/emergency-codes",
    );
    expect(codes).toEqual([expect.objectContaining({ id: "ec-1", title: "Fire alarm" })]);
  });

  it("keeps radio channels and incidents to the chosen project", () => {
    const hits = found(field, "rigging");
    expect(hits).toContain("ch-1");
    expect(hits).not.toContain("ch-2");
    expect(hits).toContain("i-1");
    expect(hits).not.toContain("i-2");
  });

  it("leaves incidents out for a person whose incident log is closed", () => {
    expect(found(field, "rigging", { allowed: () => false })).not.toContain("i-1");
  });

  it("sends people to the directory, searched for the name, for members only", () => {
    const person = searchDocs(input(field)).filter((d) => d.kind === "person");
    expect(person).toEqual([
      expect.objectContaining({ id: "m2", href: "/workforce/directory?q=Bo%20Rigger" }),
    ]);
    expect(searchDocs(input(external("vendor"))).some((d) => d.kind === "person")).toBe(false);
  });

  it("finds a vendor's submittals as the submittals page lists them", () => {
    const vendor = external("vendor");
    const hits = found(vendor, "rigging");
    expect(hits).toContain("r-approval");
    expect(hits).not.toContain("r-task");
    expect(hits).not.toContain("r-elsewhere");
    expect(found(vendor, "42")).toContain("po-1");
    // An internal person has no submittals page, so the shared records stay out.
    expect(found(field, "rigging")).not.toContain("r-approval");
  });

  it("finds open onboarding for crew and open deliverables for contractors, on their project", () => {
    expect(found(external("crew"), "rigging")).toEqual(expect.arrayContaining(["ob-1"]));
    expect(found(external("crew"), "rigging")).not.toContain("ob-2");
    expect(found(external("crew"), "rigging")).not.toContain("d-1");
    expect(found(external("contractor"), "rigging")).toContain("d-1");
    expect(found(external("contractor"), "rigging")).not.toContain("d-2");
    expect(found(external("contractor", "proj-2"), "rigging")).not.toContain("d-1");
  });

  it("adds the actions the person may take", () => {
    const actions = searchDocs(input(field)).filter((d) => d.kind === "action");
    expect(ids(actions)).toContain("reportIncident");
    expect(ids(searchDocs(input(field, { allowed: () => false })))).not.toContain("reportIncident");
  });
});
