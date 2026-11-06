import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  addIntakePayoutReference,
  createIntakeLink,
  decideIntakeRequest,
  intakeAsksForCode,
  intakeOnFile,
  intakeRequestParty,
  listIntakeRequests,
  listMyIntakeRequests,
  openIntake,
  parseIntakeRefusal,
  readIntake,
  submitVendorIntake,
  type NewIntakeLink,
} from "../src/vendor-intake.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

const TOKEN = `xvin_${"ab".repeat(32)}`;

function withSchema(queues: Record<string, Response[]>) {
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    schema: (name: string) => ({
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn: `${name}.${fn}`, args });
        const next = queues[`rpc:${name}.${fn}`]?.shift();
        if (!next) throw new Error(`no queued response for rpc:${name}.${fn}`);
        return next;
      },
      from: (view: string) => ({
        select: () => ({
          order: async () => {
            const next = queues[`from:${name}.${view}`]?.shift();
            if (!next) throw new Error(`no queued response for from:${name}.${view}`);
            return next;
          },
        }),
      }),
    }),
  } as unknown as XosClient;
  return { db, calls };
}

const link: NewIntakeLink = {
  projectId: "p",
  title: "Audio",
  roleType: "Vendor",
  roleCode: "9000.50.02",
  workerClassification: "VENDOR_SUPPLIED",
  payBasis: "Day Rate",
  arrangement: "Per Engagement",
  startDate: "2027-06-01",
  endDate: null,
  expiresAt: "2026-12-01T00:00:00Z",
  counterpartyType: "AV Integrator",
  agreementDocumentId: null,
  instructions: null,
  note: null,
  collectTaxForm: true,
  collectPayout: true,
  collectInvoice: false,
  maxRequests: 50,
};

describe("vendor intake links", () => {
  it("returns the token and code once, and refuses without them", async () => {
    const { db: client } = fakeClient({
      "rpc:create_vendor_intake_link": [
        okResponse([
          { vendor_intake_link_id: "l", token: TOKEN, access_code: "123456", expires_at: "x" },
        ]),
        okResponse([]),
      ],
    });
    expect(await createIntakeLink(client, link)).toMatchObject({
      ok: true,
      data: { id: "l", token: TOKEN, accessCode: "123456" },
    });
    expect(await createIntakeLink(client, link)).toMatchObject({
      ok: false,
      error: { kind: "unexpected" },
    });
  });

  it("maps a refusal to its rule", async () => {
    const { db: client } = fakeClient({
      "rpc:create_vendor_intake_link": [
        errorResponse("XR001", "vendor_intake_classification: no", "vendor_intake_classification"),
      ],
    });
    expect(await createIntakeLink(client, link)).toMatchObject({
      ok: false,
      error: { rule: "vendor_intake_classification" },
    });
  });

  it("knows the refusals and which the code form answers", () => {
    expect(parseIntakeRefusal("intake_link_full")).toBe("intake_link_full");
    expect(parseIntakeRefusal("other")).toBe("intake_link_invalid");
    expect(intakeAsksForCode("intake_grant")).toBe(true);
    expect(intakeAsksForCode("intake_link_locked")).toBe(false);
  });
});

describe("the anonymous side", () => {
  it("never calls for a token of the wrong shape", async () => {
    const { db, calls } = withSchema({});
    expect(
      await openIntake(db, { token: "nope", accessCode: null, clientAddress: null }),
    ).toMatchObject({ data: { refused: true } });
    expect(await readIntake(db, { token: "nope", grant: "g", clientAddress: null })).toMatchObject({
      data: { refused: true },
    });
    expect(calls).toHaveLength(0);
  });

  it("reads what the page renders", async () => {
    const { db } = withSchema({
      "rpc:api_public.vendor_intake": [
        okResponse({
          status: "ok",
          meta: { project_name: "Show", org_name: "Northwind", brand_name: "N", expires_at: "x" },
          title: "Audio",
          instructions: null,
          role_type: "Vendor",
          role_title: "Audio Engineer",
          start_date: "2027-06-01",
          end_date: null,
          collect_tax_form: true,
          collect_payout: false,
          collect_invoice: true,
          full: false,
          agreement: { title: "MSA", version: 2 },
        }),
      ],
    });
    expect(await readIntake(db, { token: TOKEN, grant: "g", clientAddress: null })).toMatchObject({
      data: {
        refused: false,
        roleType: "Vendor",
        collectInvoice: true,
        agreement: { title: "MSA", version: 2 },
      },
    });
  });
});

describe("the signed-in requester", () => {
  it("files a payout reference and surfaces a bank number refusal", async () => {
    const { db: client, calls } = fakeClient({
      "rpc:add_intake_payout_reference": [
        okResponse("payout"),
        errorResponse("XR001", "payout_reference_bank_number: no", "payout_reference_bank_number"),
      ],
    });
    const input = {
      token: TOKEN,
      grant: "g",
      reference: "V-10442",
      accountId: null,
      clientAddress: null,
    };
    expect(await addIntakePayoutReference(client, input)).toEqual({ ok: true, data: "payout" });
    expect(JSON.stringify(calls[0]?.steps)).not.toContain("p_account_id");
    expect(await addIntakePayoutReference(client, input)).toMatchObject({
      error: { rule: "payout_reference_bank_number" },
    });
  });

  it("sends only what the steps gathered", async () => {
    const { db: client, calls } = fakeClient({ "rpc:submit_vendor_intake": [okResponse("r")] });
    await submitVendorIntake(client, {
      token: TOKEN,
      grant: "g",
      accountId: "a",
      taxFormId: "t",
      payoutAccountId: null,
      signerName: "Victor",
      invoiceDraft: null,
      clientAddress: null,
    });
    const sent = JSON.stringify(calls[0]?.steps);
    expect(sent).toContain("p_tax_form_id");
    expect(sent).not.toContain("p_payout_account_id");
    expect(sent).not.toContain("p_invoice_draft");
  });

  it("reads the allowlisted view of their own requests", async () => {
    const { db } = withSchema({
      "from:api_external.my_vendor_intake_requests": [
        okResponse([
          {
            id: "r",
            org_name: "N",
            project_name: "S",
            title: "T",
            request_state: "Approved",
            decision_reason: null,
            engagement_id: "e",
            invoice_ready: true,
            invoice_used: false,
            created_at: "x",
          },
        ]),
      ],
    });
    expect(await listMyIntakeRequests(db)).toMatchObject({
      data: [{ id: "r", state: "Approved", invoiceReady: true, engagementId: "e" }],
    });
  });
});

describe("the team's side", () => {
  it("lists requests and says whether a draft came", async () => {
    const { db: client } = fakeClient({
      "from:vendor_intake_requests": [
        okResponse([
          {
            id: "r",
            vendor_intake_link_id: "l",
            project_id: "p",
            requested_by: "v",
            account_id: "a",
            tax_form_id: "t",
            payout_account_id: null,
            signer_name: null,
            signed_at: null,
            invoice_draft: { invoice_number: "1" },
            request_state: "Pending",
            decision_reason: null,
            engagement_id: null,
            created_at: "x",
          },
        ]),
      ],
    });
    expect(await listIntakeRequests(client, "p")).toMatchObject({
      data: [{ id: "r", hasInvoiceDraft: true, state: "Pending" }],
    });
  });

  it("reads the party through its definer call, and nothing without access", async () => {
    const { db: client } = fakeClient({
      "rpc:vendor_intake_request_party": [
        okResponse([{ requester_name: "Victor", account_name: "Bayside" }]),
        okResponse([]),
      ],
    });
    expect(await intakeRequestParty(client, "r")).toEqual({
      ok: true,
      data: { requesterName: "Victor", accountName: "Bayside" },
    });
    expect(await intakeRequestParty(client, "r")).toEqual({ ok: true, data: null });
  });

  it("shows a last four only when the viewer's own policy returns the row", async () => {
    const hidden = fakeClient({
      "from:tax_forms": [okResponse(null)],
      "from:payout_accounts": [okResponse(null)],
    });
    expect(await intakeOnFile(hidden.db, { taxFormId: "t", payoutAccountId: "p" })).toEqual({
      ok: true,
      data: { taxFormKind: null, tinLast4: null, payoutProvider: null, payoutLast4: null },
    });
    const holder = fakeClient({
      "from:tax_forms": [okResponse({ form_kind: "W-9", tin_last4: "6789" })],
      "from:payout_accounts": [okResponse({ provider: "Accounting System", account_last4: null })],
    });
    expect(await intakeOnFile(holder.db, { taxFormId: "t", payoutAccountId: "p" })).toMatchObject({
      data: { tinLast4: "6789", payoutProvider: "Accounting System" },
    });
  });

  it("decides with or without a reason", async () => {
    const { db: client, calls } = fakeClient({ "rpc:decide_vendor_intake": [okResponse("e")] });
    expect(await decideIntakeRequest(client, { id: "r", approve: true, reason: null })).toEqual({
      ok: true,
      data: "e",
    });
    expect(JSON.stringify(calls[0]?.steps)).not.toContain("p_reason");
  });
});
