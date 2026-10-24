import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateDocument, loadDocumentBrand } from "../../src/documents/generate.ts";
import { documentProject, loadDocumentData } from "../../src/documents/sources.ts";
import { errorResponse, fakeClient, okResponse } from "../fake-client.ts";

const EN: unknown = JSON.parse(
  readFileSync(new URL("../../../i18n/messages/en-US/documents.json", import.meta.url), "utf8"),
);
const ORG = "org-1";
const projectRow = {
  id: "p1",
  project_key: "NWF26",
  name: "Northwind",
  time_zone: "America/New_York",
};
const project = okResponse(projectRow);
const poRow = {
  id: "po1",
  project_id: "p1",
  po_number: 12,
  vendor_id: "v1",
  rfq_response_id: null,
  currency_code: "USD",
  po_state: "Sent",
  created_at: "2026-09-02T14:00:00Z",
  created_by: null,
  project: { project_key: "NWF26", name: "Northwind" },
  vendor: { counterparty: { counterparty_name: "Stagecraft" } },
};
const poLines = okResponse([
  {
    id: "l1",
    line_number: 1,
    description: "Line array",
    element_id: null,
    budget_line_id: null,
    quantity: 2,
    unit_basis: null,
    unit_price_minor: 1000,
    receipt_lines: [{ quantity_received: 1, deleted_at: null }],
  },
]);
const poTotals = okResponse({
  unpriced_count: 0,
  lines_total_minor: 2000,
  approved_changes_minor: null,
});

describe("document project", () => {
  it("answers not found for a project of another org", async () => {
    const { db, calls } = fakeClient({ "from:projects": [okResponse(null)] });
    expect(await documentProject(db, ORG, "p1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", ORG]]);
  });

  it("passes database errors through", async () => {
    const { db } = fakeClient({ "from:projects": [errorResponse("XX000", "boom")] });
    const r = await documentProject(db, ORG, "p1");
    expect(r.ok).toBe(false);
  });

  it("defaults a project without a time zone to UTC", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse({ ...projectRow, time_zone: null })],
    });
    const r = await documentProject(db, ORG, "p1");
    expect(r.ok && r.data.timeZone).toBe("UTC");
  });
});

describe("loaders read each record as the caller", () => {
  it("purchase order", async () => {
    const { db } = fakeClient({
      "from:purchase_orders": [okResponse(poRow)],
      "from:projects": [project],
      "from:po_lines": [poLines],
      "from:purchase_order_totals": [poTotals],
    });
    const r = await loadDocumentData(db, ORG, "purchase-order", "po1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.order.key).toContain("PO");
    expect(r.data.lines[0]?.receivedQuantity).toBe(1);
    expect(r.data.project.key).toBe("NWF26");
  });

  it("refuses a purchase order of another org", async () => {
    const { db } = fakeClient({
      "from:purchase_orders": [okResponse(poRow)],
      "from:projects": [okResponse(null)],
    });
    const r = await loadDocumentData(db, ORG, "purchase-order", "po1");
    expect(r).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("invoice with its counterparty", async () => {
    const { db, calls } = fakeClient({
      "from:invoices": [
        okResponse([
          {
            id: "inv1",
            project_id: "p1",
            direction: "Receivable",
            counterparty_id: "c1",
            payee_person_id: null,
            engagement_id: null,
            invoice_number: "INV-1",
            issued_on: "2026-10-01",
            due_on: null,
            currency_code: "USD",
            invoice_state: "Issued",
            created_at: "2026-09-30T00:00:00Z",
            payee: null,
          },
        ]),
      ],
      "from:invoice_totals": [
        okResponse([
          {
            invoice_id: "inv1",
            unpriced_count: 0,
            subtotal_minor: 100,
            tax_minor: 0,
            applied_minor: 0,
          },
        ]),
      ],
      "from:projects": [project],
      "from:invoice_lines": [okResponse([])],
      "from:counterparties": [okResponse({ counterparty_name: "Contoso" })],
    });
    const r = await loadDocumentData(db, ORG, "invoice", "inv1");
    expect(r.ok && r.data.counterpartyName).toBe("Contoso");
    expect(calls[0]?.steps).toContainEqual(["eq", ["id", "inv1"]]);
  });

  it("answers not found for a missing invoice or change order", async () => {
    const a = fakeClient({ "from:invoices": [okResponse([])] });
    expect((await loadDocumentData(a.db, ORG, "invoice", "x")).ok).toBe(false);
    const b = fakeClient({ "from:change_orders": [okResponse([])] });
    expect((await loadDocumentData(b.db, ORG, "change-order", "x")).ok).toBe(false);
  });

  it("change order with its budget currency", async () => {
    const { db } = fakeClient({
      "from:change_orders": [
        okResponse([
          {
            id: "co1",
            project_id: "p1",
            budget_id: "b1",
            change_order_number: 3,
            title: "Delay tower",
            order_type_enum_id: null,
            reason: null,
            requested_by: null,
            priced_by: null,
            change_order_state: "Priced",
            created_at: "2026-09-12T00:00:00Z",
          },
        ]),
      ],
      "from:change_order_totals": [
        okResponse([
          { change_order_id: "co1", line_count: 0, unpriced_count: 0, total_minor: null },
        ]),
      ],
      "from:projects": [project],
      "from:change_order_lines": [okResponse([])],
      "from:budgets": [okResponse({ name: "Production", currency_code: "EUR " })],
    });
    const r = await loadDocumentData(db, ORG, "change-order", "co1");
    expect(r.ok && r.data.currency).toBe("EUR");
  });

  it("day sheet and call sheet", async () => {
    const sheet = {
      id: "s1",
      project_id: "p1",
      day: "2026-10-24",
      body: "Gates at 16:00",
      published_at: null,
      updated_at: "2026-10-22T00:00:00Z",
      project: { project_key: "NWF26" },
    };
    const day = fakeClient({
      "from:day_sheets": [okResponse([sheet])],
      "from:projects": [project],
    });
    const d = await loadDocumentData(day.db, ORG, "day-sheet", "s1");
    expect(d.ok && d.data.sheet.body).toBe("Gates at 16:00");

    const call = fakeClient({
      "from:call_sheets": [okResponse([sheet])],
      "from:projects": [project],
      "from:shifts": [
        okResponse([
          {
            id: "sh1",
            starts_at: "2026-10-24T12:00:00Z",
            ends_at: "2026-10-24T20:00:00Z",
            role_code: null,
            membership: { person: { full_name: "Ana" } },
          },
        ]),
      ],
    });
    const c = await loadDocumentData(call.db, ORG, "call-sheet", "s1");
    expect(c.ok && c.data.calls[0]?.personName).toBe("Ana");

    const none = fakeClient({ "from:call_sheets": [okResponse([])] });
    expect((await loadDocumentData(none.db, ORG, "call-sheet", "s1")).ok).toBe(false);
    const noDay = fakeClient({ "from:day_sheets": [okResponse([])] });
    expect((await loadDocumentData(noDay.db, ORG, "day-sheet", "s1")).ok).toBe(false);
  });

  it("run of show, BEO and credential", async () => {
    const run = fakeClient({
      "from:run_of_show": [
        okResponse({
          id: "r1",
          project_id: "p1",
          scope_node_id: null,
          name: "Main stage",
          show_date: "2026-10-24",
          project: { project_key: "NWF26", name: "Northwind", time_zone: "UTC" },
          cues: [],
        }),
      ],
      "from:projects": [project],
      "from:cues": [okResponse([])],
    });
    expect((await loadDocumentData(run.db, ORG, "run-of-show", "r1")).ok).toBe(true);

    const beo = fakeClient({
      "from:beos": [
        okResponse({
          id: "b1",
          beo_number: 7,
          project_id: "p1",
          fulfillment_id: null,
          event_at: "2026-10-24T22:00:00Z",
          guest_count: 10,
          approved_at: null,
          created_by: null,
          created_at: "2026-10-18T00:00:00Z",
          project: { project_key: "NWF26", time_zone: "UTC" },
          fulfillment: null,
          approver: null,
          beo_lines: [],
        }),
      ],
      "from:projects": [project],
    });
    expect((await loadDocumentData(beo.db, ORG, "beo", "b1")).ok).toBe(true);

    const credential = fakeClient({
      "from:credentials": [
        okResponse({
          id: "c1",
          credential_number: "AAA-1",
          holder_person_id: "p",
          credential_category_id: "cat",
          valid_from: "2026-10-20T00:00:00Z",
          valid_to: null,
          revoked_at: null,
          created_at: "2026-10-15T00:00:00Z",
          updated_at: "2026-10-15T00:00:00Z",
          holder: { full_name: "Ana" },
          issuer: null,
          revoker: null,
          category: { code: "AAA", name: "All access", project_id: "p1", project: null },
        }),
      ],
      "from:projects": [project],
    });
    const c = await loadDocumentData(credential.db, ORG, "credential-badge", "c1");
    expect(c.ok && c.data.credential.holderName).toBe("Ana");

    const missing = fakeClient({ "from:beos": [okResponse(null)] });
    expect((await loadDocumentData(missing.db, ORG, "beo", "b1")).ok).toBe(false);
  });

  it("inspection report with canon result codes and people", async () => {
    const { db } = fakeClient({
      "from:inspections": [
        okResponse([
          {
            id: "i1",
            project_id: "p1",
            inspection_template_id: "t1",
            record_id: null,
            inspector_person_id: "pp1",
            inspected_at: "2026-10-23T14:00:00Z",
            signed_off_by: null,
            signed_off_at: null,
            deleted_at: null,
            inspection_results: [],
          },
        ]),
      ],
      "from:projects": [project],
      "from:inspection_templates": [
        okResponse([
          {
            id: "t1",
            name: "Daily walk",
            deleted_at: null,
            updated_at: "2026-10-01T00:00:00Z",
            inspection_items: [
              { id: "it1", position: 1, prompt: "Ballast", is_critical: true, deleted_at: null },
            ],
          },
        ]),
      ],
      "from:xpms.std_enumeration": [
        okResponse([{ record_id: "ENM-082", enum_code: "INSP_PASSED", is_default: false }]),
      ],
      "from:people": [okResponse([{ id: "pp1", full_name: "Ana" }])],
    });
    const r = await loadDocumentData(db, ORG, "inspection-report", "i1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.templateName).toBe("Daily walk");
    expect(r.data.resultCodes).toEqual({ "ENM-082": "INSP_PASSED" });
    expect(r.data.inspectorName).toBe("Ana");
    expect(r.data.signedOffByName).toBeNull();
  });

  it("incident report with severity and history", async () => {
    const { db } = fakeClient({
      "from:incidents": [
        okResponse({
          id: "in1",
          project_id: "p1",
          incident_number: 4,
          title: "Slip",
          severity_enum_id: "sev2",
          zone_id: null,
          occurred_at: "2026-10-24T23:40:00Z",
          reported_by: null,
          incident_state: "Reported",
          created_at: "2026-10-24T23:45:00Z",
          updated_at: "2026-10-24T23:45:00Z",
          project: { project_key: "NWF26" },
          zone: null,
          reporter: null,
          signer: null,
          dispatch_assignments: [],
        }),
      ],
      "from:projects": [project],
      "from:xpms.std_enumeration": [
        okResponse([
          { record_id: "sev2", enum_code: "MOD", enum_label: "Moderate", sort_order: 2 },
        ]),
      ],
      "from:incident_state_transitions": [okResponse([])],
    });
    const r = await loadDocumentData(db, ORG, "incident-report", "in1");
    expect(r.ok && r.data.severityLabel).toBe("Moderate");
  });

  it("final cost report needs a project of the org", async () => {
    const { db } = fakeClient({ "from:projects": [okResponse(null)] });
    expect((await loadDocumentData(db, ORG, "final-cost-report", "p1")).ok).toBe(false);
  });

  const agreementRow = (signed: boolean) => ({
    id: "a1",
    project_id: "p1",
    offer_id: null,
    person_id: "pp1",
    counterparty_id: null,
    agreement_kind: "Contractor Agreement",
    title: "Audio A1",
    agreement_state: signed ? "Signed" : "Sent",
    token_expires_at: null,
    signed_at: signed ? "2026-09-20T18:12:00Z" : null,
    signed_name: signed ? "Ana" : null,
    created_at: "2026-09-18T00:00:00Z",
    person: { full_name: "Ana" },
    body: "Text",
    signed_body_sha256: signed ? "abc" : null,
  });

  it("issues a certificate only for a signed agreement of the org", async () => {
    const signed = fakeClient({
      "from:agreements": [okResponse({ org_id: ORG }), okResponse(agreementRow(true))],
      "from:agreement_state_transitions": [okResponse([])],
      "from:projects": [okResponse(null)],
    });
    const r = await loadDocumentData(signed.db, ORG, "agreement-certificate", "a1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.project).toBeNull();

    const unsigned = fakeClient({
      "from:agreements": [okResponse({ org_id: ORG }), okResponse(agreementRow(false))],
      "from:agreement_state_transitions": [okResponse([])],
    });
    expect(await loadDocumentData(unsigned.db, ORG, "agreement-certificate", "a1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });

    const other = fakeClient({ "from:agreements": [okResponse(null)] });
    expect((await loadDocumentData(other.db, ORG, "agreement-certificate", "a1")).ok).toBe(false);
  });
});

describe("generateDocument", () => {
  const queues = () => ({
    "from:purchase_orders": [okResponse(poRow)],
    "from:projects": [project],
    "from:po_lines": [poLines],
    "from:purchase_order_totals": [poTotals],
    "from:org_brands": [okResponse(null)],
    "from:setting_values": [okResponse(null)],
  });

  // The file's only render loads pdfkit and fontkit first: a quarter of a second on a laptop, but
  // seconds on a CI runner busy with every package's tests, hence the longer timeout.
  it("renders the record as a named PDF with the template version", async () => {
    const { db } = fakeClient(queues());
    let linked: string | null = null;
    const r = await generateDocument({
      db,
      orgId: ORG,
      orgName: "Northwind Live",
      kind: "purchase-order",
      id: "po1",
      locale: "en-US",
      messages: EN,
      paper: "letter",
      recordUrl: ({ projectKey }) => {
        linked = projectKey;
        return "https://atlas.example.test/po1";
      },
      now: new Date("2026-10-19T00:00:00Z"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(linked).toBe("NWF26");
    expect(r.data.templateVersion).toBe(1);
    expect(r.data.fileName).toMatch(/^purchase-order-NWF26-PO-?12-letter\.pdf$/);
    expect(Buffer.from(r.data.bytes).toString("latin1", 0, 8)).toBe("%PDF-1.7");
  }, 20_000);

  it("passes a refusal through without rendering", async () => {
    const { db } = fakeClient({ "from:purchase_orders": [okResponse(null)] });
    const r = await generateDocument({
      db,
      orgId: ORG,
      orgName: "Northwind Live",
      kind: "purchase-order",
      id: "po1",
      locale: "en-US",
      messages: EN,
      paper: "a4",
      recordUrl: () => "u",
    });
    expect(r).toEqual({ ok: false, error: { kind: "not-found" } });
  });
});

describe("loadDocumentBrand", () => {
  const alt = (name: string) => `${name} logo`;

  it("names the org's registered legal name (org.legal_name) on documents", async () => {
    const { db } = fakeClient({
      "from:org_brands": [okResponse(null)],
      "from:setting_values": [okResponse({ value_text: " Northwind Live LLC " })],
    });
    const brand = await loadDocumentBrand(db, ORG, "Northwind Live", alt);
    expect(brand.name).toBe("Northwind Live");
    expect(brand.legalEntity).toBe("Northwind Live LLC");
  });

  it("prefers the white-label legal entity, and falls back to none", async () => {
    const branded = fakeClient({
      "from:org_brands": [
        okResponse({
          id: "b1",
          display_name: "Northwind",
          legal_entity_name: "Northwind Brands Inc",
          radius_scale: "Default",
        }),
      ],
      "from:setting_values": [okResponse({ value_text: "Northwind Live LLC" })],
    });
    expect((await loadDocumentBrand(branded.db, ORG, "Northwind Live", alt)).legalEntity).toBe(
      "Northwind Brands Inc",
    );
    const bare = fakeClient({
      "from:org_brands": [okResponse(null)],
      "from:setting_values": [okResponse(null)],
    });
    expect((await loadDocumentBrand(bare.db, ORG, "Northwind Live", alt)).legalEntity).toBeNull();
  });
});
