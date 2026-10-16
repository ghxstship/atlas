import { describe, expect, it } from "vitest";
import {
  adpProvider,
  gustoProvider,
  parsePayrollCsv,
  payrollConnector,
  payrollConnectors,
  ripplingProvider,
  supabasePayrollSource,
  type PayrollSource,
} from "../src/connectors/payroll/index.ts";
import type { ExternalId } from "../src/framework/store.ts";
import { bodyOf, contextFor, memoryStore, okData, recordingDb, scriptedHttp } from "./doubles.ts";

const HEADER =
  "payroll_run_id,pay_period_start,pay_period_end,person_id,membership_id,earning_code,hours,rate_minor,amount_minor,currency_code";
const csv = [
  HEADER,
  "run-1,2027-06-07,2027-06-20,per-1,mem-1,REG,38.5,3200,123200,USD",
  "run-1,2027-06-07,2027-06-20,per-1,mem-1,OT,4,4800,19200,USD",
  "run-1,2027-06-07,2027-06-20,per-2,mem-2,REG,10,2500,25000,USD",
  "",
].join("\n");

const file = {
  exportId: "exp-1",
  checksum: "a".repeat(64),
  content: csv,
  periodStart: "2027-06-07",
  periodEnd: "2027-06-20",
};
const run = {
  scope: "Payroll Export" as const,
  direction: "Outbound" as const,
  subjectEntity: "Payroll Run" as const,
  subjectId: "run-1",
};

const pairs = (overrides: ExternalId[] = []): ExternalId[] => [
  {
    entity: "Membership",
    localId: "mem-1",
    externalId: "emp-uuid-1",
    externalVersion: null,
    contentHash: null,
  },
  {
    entity: "Membership",
    localId: "mem-2",
    externalId: "emp-uuid-2",
    externalVersion: null,
    contentHash: null,
  },
  {
    entity: "Earning Code",
    localId: "ec-reg",
    externalId: "Regular Hours",
    externalVersion: null,
    contentHash: null,
  },
  {
    entity: "Earning Code",
    localId: "ec-ot",
    externalId: "Overtime",
    externalVersion: null,
    contentHash: null,
  },
  ...overrides,
];

const source = (overrides: Partial<PayrollSource> = {}): PayrollSource => ({
  handoffFile: async () => file,
  earningCodeIds: async () =>
    new Map([
      ["REG", "ec-reg"],
      ["OT", "ec-ot"],
    ]),
  exponentOf: async () => 2,
  ...overrides,
});

describe("payroll CSV", () => {
  it("parses the Universal CSV with money in minor units", () => {
    const lines = parsePayrollCsv(csv);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      personId: "per-1",
      membershipId: "mem-1",
      earningCode: "REG",
      hours: "38.5",
      rateMinor: 3200n,
      amountMinor: 123200n,
      currencyCode: "USD",
    });
    expect(parsePayrollCsv(`${HEADER}\n`)).toEqual([]);
  });

  it("refuses files that are not the Universal CSV", () => {
    expect(() => parsePayrollCsv("a,b\n")).toThrow(
      expect.objectContaining({ code: "payroll_file_malformed" }),
    );
    expect(() => parsePayrollCsv(`${HEADER}\nrun,a,b,per,mem,REG,1,2\n`)).toThrow(
      /row 2 does not have ten/,
    );
    expect(() => parsePayrollCsv(`${HEADER}\nrun,a,b,per,mem,REG,lots,2,3,USD\n`)).toThrow(
      /row 2 has a malformed number/,
    );
  });
});

describe("Gusto handoff", () => {
  it("fills the unprocessed payroll of the pay period, grouped by employee", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://api.gusto.com/v1/companies/acct-1/payrolls",
        respond: () => ({
          json: [
            {
              payroll_uuid: "other",
              version: "v0",
              pay_period: { start_date: "2027-05-24", end_date: "2027-06-06" },
            },
            {
              payroll_uuid: "pay-9",
              version: "v1",
              pay_period: { start_date: "2027-06-07", end_date: "2027-06-20" },
            },
          ],
        }),
      },
      {
        match: "PUT https://api.gusto.com/v1/companies/acct-1/payrolls/pay-9",
        respond: () => ({ json: { payroll_uuid: "pay-9", version: "v2" } }),
      },
    ]);
    const memory = memoryStore(pairs());
    const outcome = await payrollConnector(gustoProvider, source()).sync(
      contextFor("gusto", { http, store: memory.store, run }),
    );
    expect(requests[0]?.url).toContain("start_date=2027-06-07&end_date=2027-06-20");
    expect(bodyOf(requests[1])).toEqual({
      version: "v1",
      employee_compensations: [
        {
          employee_uuid: "emp-uuid-1",
          hourly_compensations: [
            { name: "Regular Hours", hours: "38.5" },
            { name: "Overtime", hours: "4" },
          ],
        },
        {
          employee_uuid: "emp-uuid-2",
          hourly_compensations: [{ name: "Regular Hours", hours: "10" }],
        },
      ],
    });
    expect(memory.externalIds.find((x) => x.entity === "Payroll Run")).toEqual({
      entity: "Payroll Run",
      localId: "run-1",
      externalId: "pay-9",
      externalVersion: "v2",
      contentHash: file.checksum,
    });
    expect(outcome.counts).toEqual({ read: 3, written: 3, skipped: 0, failed: 0 });

    const again = await payrollConnector(gustoProvider, source()).sync(
      contextFor("gusto", { http, store: memory.store, run }),
    );
    expect(again.counts).toEqual({ read: 1, written: 0, skipped: 1, failed: 0 });
    expect(requests).toHaveLength(2);
  });

  it("sends nothing when any line is unmapped", async () => {
    const { http, requests } = scriptedHttp([]);
    const memory = memoryStore(
      pairs().filter((p) => p.localId !== "mem-2" && p.localId !== "ec-ot"),
    );
    await expect(
      payrollConnector(
        gustoProvider,
        source({ earningCodeIds: async () => new Map([["REG", "ec-reg"]]) }),
      ).sync(contextFor("gusto", { http, store: memory.store, run })),
    ).rejects.toMatchObject({
      code: "payroll_mapping_incomplete",
      retryable: false,
    });
    expect(requests).toHaveLength(0);
    expect(memory.itemErrors.map((e) => [e.code, e.ref])).toEqual([
      ["earning_code_unmapped", { entity: "Earning Code" }],
      ["employee_unmapped", { entity: "Membership", localId: "mem-2" }],
    ]);
    const second = memoryStore(pairs().filter((p) => p.localId !== "ec-ot"));
    await expect(
      payrollConnector(gustoProvider, source()).sync(
        contextFor("gusto", { http, store: second.store, run }),
      ),
    ).rejects.toMatchObject({ code: "payroll_mapping_incomplete" });
    expect(second.itemErrors[0]?.ref).toEqual({ entity: "Earning Code", localId: "ec-ot" });
  });

  it("refuses a run without a subject, a missing payroll and a missing company", async () => {
    const memory = memoryStore(pairs());
    const { http } = scriptedHttp([
      { match: "GET https://api.gusto.com", respond: () => ({ json: [] }) },
    ]);
    await expect(
      payrollConnector(gustoProvider, source()).sync(
        contextFor("gusto", { http, store: memory.store, run: { ...run, subjectId: null } }),
      ),
    ).rejects.toMatchObject({ code: "payroll_subject_missing" });
    await expect(
      payrollConnector(gustoProvider, source()).sync(
        contextFor("gusto", {
          http,
          store: memory.store,
          run,
          credential: { token: "t", fields: { company_uuid: "company-2" } },
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_payroll_missing" });
    const context = contextFor("gusto", { http, store: memory.store, run });
    await expect(
      payrollConnector(gustoProvider, source()).sync({
        ...context,
        connection: { ...context.connection, externalAccountId: null },
      }),
    ).rejects.toMatchObject({ code: "credential_incomplete" });
    await expect(
      payrollConnector(gustoProvider, source()).sync({ ...context, credential: null }),
    ).rejects.toMatchObject({ code: "credential_required" });
  });
});

describe("ADP and Rippling handoff", () => {
  it("sends pay data input to ADP with decimal rates", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://api.adp.com/events/payroll/v1/pay-data-input.modify",
        respond: () => ({ json: { events: [{ eventID: "evt-1" }] } }),
      },
    ]);
    const memory = memoryStore(pairs());
    await payrollConnector(adpProvider, source()).sync(
      contextFor("adp", {
        http,
        store: memory.store,
        run,
        settings: { payroll_group_code: "3U7" },
      }),
    );
    const body = bodyOf(requests[0]) as {
      events: { data: { transform: { payDataInput: { payeePayInputs: unknown[] } } } }[];
    };
    expect(body.events[0]?.data.transform.payDataInput.payeePayInputs[0]).toEqual({
      associateOID: "emp-uuid-1",
      payrollGroupCode: { codeValue: "3U7" },
      payInputs: [
        {
          earningInputs: [
            {
              earningCode: { codeValue: "Regular Hours" },
              numberOfHours: "38.5",
              rate: { rateValue: "32.00", currencyCode: "USD" },
            },
            {
              earningCode: { codeValue: "Overtime" },
              numberOfHours: "4",
              rate: { rateValue: "48.00", currencyCode: "USD" },
            },
          ],
        },
      ],
    });
    expect(memory.externalIds.find((x) => x.entity === "Payroll Run")?.externalId).toBe("evt-1");
    await expect(
      payrollConnector(adpProvider, source()).sync(
        contextFor("adp", { http, store: memoryStore(pairs()).store, run }),
      ),
    ).rejects.toMatchObject({ code: "setting_missing" });
    const empty = scriptedHttp([
      { match: "POST https://api.adp.com", respond: () => ({ json: {} }) },
    ]);
    await expect(
      payrollConnector(adpProvider, source()).sync(
        contextFor("adp", {
          http: empty.http,
          store: memoryStore(pairs()).store,
          run,
          settings: { payroll_group_code: "3U7" },
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
  });

  it("imports earnings into Rippling and handles an empty run", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://api.rippling.com/platform/api/payroll/earning_imports",
        respond: () => ({ json: { id: "imp-1" } }),
      },
    ]);
    await payrollConnector(ripplingProvider, source()).sync(
      contextFor("rippling", { http, store: memoryStore(pairs()).store, run }),
    );
    const sent = bodyOf(requests[0]) as { pay_period: unknown; earnings: unknown[] };
    expect(sent.pay_period).toEqual({ start_date: "2027-06-07", end_date: "2027-06-20" });
    expect(sent.earnings[0]).toEqual({
      employee_id: "emp-uuid-1",
      earning_type: "Regular Hours",
      hours: "38.5",
      rate: "32.00",
      amount: "1232.00",
      currency: "USD",
    });
    const empty = await payrollConnector(
      ripplingProvider,
      source({ handoffFile: async () => ({ ...file, content: `${HEADER}\n` }) }),
    ).sync(contextFor("rippling", { http, store: memoryStore(pairs()).store, run }));
    expect(empty.counts).toEqual({ read: 0, written: 0, skipped: 0, failed: 0 });
    expect(payrollConnectors(source()).map((c) => c.provider)).toEqual([
      "gusto",
      "adp",
      "rippling",
    ]);
  });
});

describe("payroll source", () => {
  it("reads the handoff file, earning codes and exponents", async () => {
    const { db } = recordingDb({
      "rpc:payroll_export_for_handoff": [
        okData([
          {
            payroll_export_id: "e",
            checksum_sha256: "c",
            content: "x",
            pay_period_start: "s",
            pay_period_end: "f",
          },
        ]),
        okData([]),
      ],
      "from:earning_codes": [okData([{ id: "ec", code: "REG" }])],
      "from:currencies": [okData({ minor_unit_exponent: 2 }), okData(null)],
    });
    const s = supabasePayrollSource(db);
    expect(await s.handoffFile("c", "r")).toEqual({
      exportId: "e",
      checksum: "c",
      content: "x",
      periodStart: "s",
      periodEnd: "f",
    });
    await expect(s.handoffFile("c", "r")).rejects.toMatchObject({ code: "payroll_export_missing" });
    expect((await s.earningCodeIds("o")).get("REG")).toBe("ec");
    expect(await s.exponentOf("USD")).toBe(2);
    await expect(s.exponentOf("QQQ")).rejects.toMatchObject({ code: "currency_unknown" });
  });
});
