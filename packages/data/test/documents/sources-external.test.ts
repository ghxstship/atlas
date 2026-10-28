import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateExternalDocument } from "../../src/documents/generate.ts";
import {
  isExternalDocumentKind,
  loadExternalDocumentData,
} from "../../src/documents/sources-external.ts";
import { fakeClient, okResponse } from "../fake-client.ts";

const EN: unknown = JSON.parse(
  readFileSync(new URL("../../../i18n/messages/en-US/documents.json", import.meta.url), "utf8"),
);
const v = (view: string) => `from:api_external.${view}`;
const project = okResponse([{ id: "p1", name: "Northwind", org_id: "org-1", time_zone: "UTC" }]);
const engagement = okResponse([{ org_name: "Northwind Live" }]);

describe("Gateway documents read the api_external views", () => {
  it("offers only the records Gateway tabs list", () => {
    expect(isExternalDocumentKind("purchase-order")).toBe(true);
    expect(isExternalDocumentKind("incident-report")).toBe(false);
  });

  it("purchase order with NULL-aware totals", async () => {
    const { db } = fakeClient({
      [v("purchase_orders")]: [
        okResponse([
          {
            id: "po1",
            project_id: "p1",
            org_id: "org-1",
            org_name: "Northwind Live",
            po_number: 12,
            po_state: "Sent",
            currency_code: "USD",
            sent_at: "2026-09-03T00:00:00Z",
            account_id: "a1",
            project_name: "Northwind",
          },
        ]),
      ],
      [v("po_lines")]: [
        okResponse([
          {
            id: "l1",
            line_number: 1,
            description: "A",
            quantity: 2,
            unit_price_minor: 100,
            amount_minor: 200,
            element_id: null,
            unit_basis: null,
          },
          {
            id: "l2",
            line_number: 2,
            description: "B",
            quantity: 1,
            unit_price_minor: null,
            amount_minor: null,
            element_id: null,
            unit_basis: null,
          },
        ]),
      ],
      [v("projects")]: [project],
      [v("engagements")]: [engagement],
    });
    const r = await loadExternalDocumentData(db, "purchase-order", "po1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.orgId).toBe("org-1");
    expect(r.data.data.order.key).toBe("PO12");
    expect(r.data.data.totals).toEqual({
      unpricedCount: 1,
      linesTotalMinor: null,
      approvedChangesMinor: null,
    });
  });

  it("answers not found when the view shows no row", async () => {
    for (const [kind, view] of [
      ["purchase-order", "purchase_orders"],
      ["invoice", "invoices"],
      ["change-order", "change_orders"],
      ["run-of-show", "run_of_show"],
      ["credential-badge", "credentials"],
    ] as const) {
      const { db } = fakeClient({ [v(view)]: [okResponse([])] });
      expect(await loadExternalDocumentData(db, kind, "x")).toEqual({
        ok: false,
        error: { kind: "not-found" },
      });
    }
  });

  it("invoice derives tax from the total and the priced subtotal", async () => {
    const { db } = fakeClient({
      [v("invoices")]: [
        okResponse([
          {
            id: "i1",
            project_id: "p1",
            org_id: "org-1",
            org_name: null,
            direction: "Payable",
            invoice_number: "V-1",
            issued_on: "2026-10-01",
            due_on: null,
            currency_code: "USD",
            invoice_state: "Issued",
            total_minor: 1100,
            applied_minor: 0,
            payee_person_id: null,
            engagement_id: "e1",
            issued_at: "2026-10-01T00:00:00Z",
            submitted_at: null,
            project_name: null,
          },
        ]),
      ],
      [v("invoice_lines")]: [
        okResponse([
          {
            id: "x",
            line_number: 1,
            description: "Fee",
            quantity: 1,
            unit_price_minor: 1000,
            amount_minor: 1000,
          },
        ]),
      ],
      [v("projects")]: [project],
      [v("engagements")]: [engagement],
    });
    const r = await loadExternalDocumentData(db, "invoice", "i1");
    expect(r.ok && r.data.data.invoice.taxMinor).toBe(100);
    expect(r.ok && r.data.orgName).toBe("Northwind Live");
  });

  it("change order restores its project key and number from the view key", async () => {
    const { db } = fakeClient({
      [v("change_orders")]: [
        okResponse([
          {
            id: "c1",
            project_id: "p1",
            change_order_key: "NWF26-CO3",
            title: "Tower",
            change_purpose: "Growth",
            change_order_state: "Priced",
            currency_code: "USD",
            total_minor: 500,
          },
        ]),
      ],
      [v("change_order_lines")]: [
        okResponse([
          {
            id: "l",
            description: "Permit",
            urid: "5000.02",
            quantity: 1,
            unit_price_minor: null,
            amount_minor: null,
            is_no_cost: true,
          },
        ]),
      ],
      [v("projects")]: [project],
      [v("engagements")]: [engagement],
    });
    const r = await loadExternalDocumentData(db, "change-order", "c1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.data.project.key).toBe("NWF26");
    expect(r.data.data.order.number).toBe(3);
    expect(r.data.data.order.unpricedCount).toBe(0);
  });

  it("run of show and credential badge", async () => {
    const run = fakeClient({
      [v("run_of_show")]: [
        okResponse([
          {
            id: "r1",
            project_id: "p1",
            name: "Main",
            show_date: "2026-10-24",
            project_name: "Northwind",
          },
        ]),
      ],
      [v("cues")]: [
        okResponse([
          {
            id: "q",
            label: "Go",
            position: 1,
            planned_at: null,
            duration: "00:01:30",
            called_at: "2026-10-24T23:00:00Z",
          },
          {
            id: "q2",
            label: "Encore",
            position: 2,
            planned_at: "2026-10-25T01:00:00Z",
            duration: null,
            called_at: null,
            start_tbc: true,
          },
        ]),
      ],
      [v("projects")]: [project],
      [v("engagements")]: [engagement],
    });
    const r = await loadExternalDocumentData(run.db, "run-of-show", "r1");
    expect(r.ok && r.data.data.cues[0]?.durationSeconds).toBe(90);
    expect(r.ok && r.data.data.run.calledCount).toBe(1);
    // A cue to be confirmed reads TBC from api_external.cues; department calls stay internal (ADR 0131).
    expect(r.ok && r.data.data.cues.map((c) => c.startTbc)).toEqual([false, true]);
    expect(r.ok && r.data.data.calls).toEqual([]);

    const badge = fakeClient({
      [v("credentials")]: [
        okResponse([
          {
            id: "c1",
            project_id: "p1",
            credential_number: "AAA-1",
            holder_name: "Ana",
            holder_person_id: "pp",
            category_code: "AAA",
            category_name: "All access",
            valid_from: "2026-10-20T00:00:00Z",
            valid_to: null,
            revoked_at: null,
            project_name: "Northwind",
          },
        ]),
      ],
      [v("projects")]: [okResponse([])],
      [v("engagements")]: [okResponse([])],
    });
    // A project the caller cannot see leaves no org to brand the document with.
    expect((await loadExternalDocumentData(badge.db, "credential-badge", "c1")).ok).toBe(false);
  });

  // The file's only render loads pdfkit and fontkit first: a quarter of a second on a laptop, but
  // seconds on a CI runner busy with every package's tests, hence the longer timeout.
  it("renders a Gateway document under the record's org", async () => {
    const { db } = fakeClient({
      [v("credentials")]: [
        okResponse([
          {
            id: "c1",
            project_id: "p1",
            credential_number: "AAA-1",
            holder_name: "Ana",
            holder_person_id: "pp",
            category_code: "AAA",
            category_name: "All access",
            valid_from: "2026-10-20T00:00:00Z",
            valid_to: null,
            revoked_at: null,
            project_name: "Northwind",
          },
        ]),
      ],
      [v("projects")]: [project],
      [v("engagements")]: [engagement],
      "from:org_brands": [okResponse(null)],
      "from:setting_values": [okResponse(null)],
    });
    const r = await generateExternalDocument({
      db,
      kind: "credential-badge",
      id: "c1",
      locale: "en-US",
      messages: EN,
      paper: "a4",
      recordUrl: ({ recordKey }) => `https://gateway.example.test/${recordKey}`,
      now: new Date("2026-10-19T00:00:00Z"),
    });
    expect(r.ok && r.data.fileName).toBe("credential-badge-AAA-1-a4.pdf");
  }, 20_000);
});
