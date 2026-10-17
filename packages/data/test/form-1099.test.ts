import { describe, expect, it } from "vitest";
import {
  FIRE_1099_NEC_COLUMNS,
  fileable,
  fireAmount,
  form1099NecCsv,
  listForm1099NecRows,
  payeeAccountNumber,
  type Form1099NecRow,
} from "../src/form-1099.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const row = (over: Partial<Form1099NecRow> = {}): Form1099NecRow => ({
  payeePersonId: "01a14a82-237c-7404-bac8-eabd604ddb91",
  payeeOrganizationId: null,
  payeeName: "Ivy R. Marchetti",
  taxFormId: "t1",
  w9OnFile: true,
  tinType: 2,
  tinLast4: "6789",
  tin: "123456789",
  streetAddress: "1 Pier Way",
  locality: "Miami",
  regionCode: "FL",
  postalCode: "33101-2040",
  addressComplete: true,
  amountMinor: 75000,
  paymentCount: 2,
  ...over,
});

describe("1099-NEC export", () => {
  it("reads the year's rows and names a refusal", async () => {
    const { db, calls } = fakeClient({
      "rpc:form_1099_nec_rows": [
        okResponse([
          {
            payee_person_id: "p1",
            payee_organization_id: null,
            payee_name: "Ivy Marchetti",
            tax_form_id: null,
            w9_on_file: false,
            tin_type: null,
            tin_last4: null,
            tin: null,
            street_address: null,
            locality: null,
            region_code: null,
            postal_code: null,
            address_complete: false,
            amount_minor: 75000,
            payment_count: 2,
          },
        ]),
        errorResponse("XR001", "step_up_required: refused.", "step_up_required"),
      ],
    });
    const read = await listForm1099NecRows(db, { orgId: "o1", year: 2025 });
    expect(read.ok && read.data[0]).toMatchObject({
      payeePersonId: "p1",
      w9OnFile: false,
      tinType: null,
      amountMinor: 75000,
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_year: 2025, p_include_tin: false }],
    ]);
    const refused = await listForm1099NecRows(db, { orgId: "o1", year: 2025, includeTin: true });
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "step_up_required",
    );
  });

  it("writes fileable rows in FIRE B record order and lists the rest", () => {
    const missing = row({ payeeName: "No Form", w9OnFile: false, tin: null, tinType: null });
    const out = form1099NecCsv([row(), missing], 2025);
    const [header, first] = out.csv.trim().split("\r\n");
    expect(header?.split(",")[0]).toBe(FIRE_1099_NEC_COLUMNS[0]);
    expect(first).toBe(
      "B,2025,NE,1,2,123456789,01a14a82237c7404bac8,000000075000,,Ivy R. Marchetti,,1 Pier Way,Miami,FL,331012040,,,",
    );
    expect(out.filed).toBe(1);
    expect(out.missing.map((r) => r.payeeName)).toEqual(["No Form"]);
  });

  it("formats amounts and account numbers as the record requires", () => {
    expect(fireAmount(75000)).toBe("000000075000");
    expect(fireAmount(-5)).toBe("000000000000");
    expect(payeeAccountNumber(row({ payeePersonId: null, payeeOrganizationId: "a-b-c" }))).toBe(
      "abc",
    );
    expect(fileable(row({ addressComplete: false }))).toBe(false);
    expect(fileable(row())).toBe(true);
  });
});
