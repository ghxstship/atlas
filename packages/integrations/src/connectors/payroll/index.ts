import type { ProviderCode } from "../../framework/catalog.ts";
import { ItemTally, type Connector, type SyncContext } from "../../framework/connector.ts";
import { unwrap, type DbClient } from "../../framework/db.ts";
import { IntegrationError } from "../../framework/errors.ts";
import { callJson } from "../../framework/http.ts";
import { credentialField, minorToDecimal } from "../../framework/support.ts";

/** A payroll export a person produced for this provider (A13 0461), handed to the runner by migration 0632. */
export interface HandoffFile {
  readonly exportId: string;
  readonly checksum: string;
  readonly content: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/** One row of the Universal payroll CSV. Money stays in minor units. */
export interface PayrollLine {
  readonly personId: string;
  readonly membershipId: string;
  readonly earningCode: string;
  readonly hours: string;
  readonly rateMinor: bigint;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
}

/** A payroll line with the provider's employee and earning identifiers. */
export interface MappedLine extends PayrollLine {
  readonly employeeId: string;
  readonly providerEarning: string;
}

export interface PayrollSource {
  handoffFile(connectionId: string, payrollRunId: string): Promise<HandoffFile>;
  earningCodeIds(orgId: string): Promise<ReadonlyMap<string, string>>;
  exponentOf(currencyCode: string): Promise<number>;
}

export interface PayrollHandoff {
  readonly lines: readonly MappedLine[];
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly exponent: number;
}

export interface PayrollProvider {
  readonly provider: ProviderCode;
  readonly label: string;
  /** Hands the mapped lines to the provider and returns its reference for the import. */
  handoff(
    context: SyncContext,
    handoff: PayrollHandoff,
  ): Promise<{ readonly reference: string; readonly version: string | null }>;
}

const HEADER =
  "payroll_run_id,pay_period_start,pay_period_end,person_id,membership_id,earning_code,hours,rate_minor,amount_minor,currency_code";

/** Parses A13's Universal payroll CSV. Any deviation from its shape refuses the file rather than guessing. */
export function parsePayrollCsv(content: string): PayrollLine[] {
  const rows = content.split("\n").filter((row) => row.length > 0);
  if (rows[0] !== HEADER)
    throw new IntegrationError(
      "payroll_file_malformed",
      "The payroll export does not have the Universal CSV header.",
    );
  return rows.slice(1).map((row, index) => {
    const cells = row.split(",");
    const [, , , personId, membershipId, earningCode, hours, rate, amount, currency] = cells;
    if (
      cells.length !== 10 ||
      !personId ||
      !membershipId ||
      !earningCode ||
      !hours ||
      !rate ||
      !amount ||
      !currency
    ) {
      throw new IntegrationError(
        "payroll_file_malformed",
        `Payroll export row ${index + 2} does not have ten filled columns.`,
      );
    }
    if (!/^\d+(\.\d+)?$/.test(hours) || !/^-?\d+$/.test(rate) || !/^-?\d+$/.test(amount)) {
      throw new IntegrationError(
        "payroll_file_malformed",
        `Payroll export row ${index + 2} has a malformed number.`,
      );
    }
    return {
      personId,
      membershipId,
      earningCode,
      hours,
      rateMinor: BigInt(rate),
      amountMinor: BigInt(amount),
      currencyCode: currency,
    };
  });
}

function token(context: SyncContext): string {
  if (context.credential === null) {
    throw new IntegrationError("credential_required", "The connection has no stored credential.", {
      connectionError: true,
    });
  }
  return context.credential.token;
}

function companyId(context: SyncContext, field: string): string {
  if (context.credential?.fields[field] !== undefined)
    return credentialField(context.credential, field);
  if (context.connection.externalAccountId !== null) return context.connection.externalAccountId;
  throw new IntegrationError(
    "credential_incomplete",
    `The stored credential is missing ${field}.`,
    { connectionError: true },
  );
}

function byEmployee(lines: readonly MappedLine[]): Map<string, MappedLine[]> {
  const groups = new Map<string, MappedLine[]>();
  for (const line of lines)
    groups.set(line.employeeId, [...(groups.get(line.employeeId) ?? []), line]);
  return groups;
}

// Gusto ------------------------------------------------------------------------------------------------------------------

const GUSTO = "https://api.gusto.com/v1";

export const gustoProvider: PayrollProvider = {
  provider: "gusto",
  label: "Gusto",
  async handoff(context, handoff) {
    const company = companyId(context, "company_uuid");
    const payrolls = await callJson<
      {
        payroll_uuid: string;
        version: string;
        pay_period: { start_date: string; end_date: string };
      }[]
    >(context.http, "Gusto", {
      method: "GET",
      url: `${GUSTO}/companies/${encodeURIComponent(company)}/payrolls?processing_statuses=unprocessed&start_date=${handoff.periodStart}&end_date=${handoff.periodEnd}`,
      token: token(context),
    });
    const payroll = payrolls.find(
      (p) =>
        p.pay_period.start_date === handoff.periodStart &&
        p.pay_period.end_date === handoff.periodEnd,
    );
    if (payroll === undefined) {
      throw new IntegrationError(
        "provider_payroll_missing",
        `Gusto has no unprocessed payroll for ${handoff.periodStart} to ${handoff.periodEnd}.`,
      );
    }
    const updated = await callJson<{ payroll_uuid: string; version: string }>(
      context.http,
      "Gusto",
      {
        method: "PUT",
        url: `${GUSTO}/companies/${encodeURIComponent(company)}/payrolls/${encodeURIComponent(payroll.payroll_uuid)}`,
        token: token(context),
        json: {
          version: payroll.version,
          employee_compensations: [...byEmployee(handoff.lines)].map(([employee, lines]) => ({
            employee_uuid: employee,
            hourly_compensations: lines.map((l) => ({ name: l.providerEarning, hours: l.hours })),
          })),
        },
      },
    );
    return { reference: updated.payroll_uuid, version: updated.version };
  },
};

// ADP --------------------------------------------------------------------------------------------------------------------

export const adpProvider: PayrollProvider = {
  provider: "adp",
  label: "ADP",
  async handoff(context, handoff) {
    const group = context.connection.settings["payroll_group_code"];
    if (typeof group !== "string" || group.length === 0) {
      throw new IntegrationError(
        "setting_missing",
        "The connection needs the payroll_group_code setting.",
      );
    }
    const response = await callJson<{ events?: { eventID?: string }[] }>(context.http, "ADP", {
      method: "POST",
      url: "https://api.adp.com/events/payroll/v1/pay-data-input.modify",
      token: token(context),
      json: {
        events: [
          {
            data: {
              transform: {
                payDataInput: {
                  payeePayInputs: [...byEmployee(handoff.lines)].map(([employee, lines]) => ({
                    associateOID: employee,
                    payrollGroupCode: { codeValue: group },
                    payInputs: [
                      {
                        earningInputs: lines.map((l) => ({
                          earningCode: { codeValue: l.providerEarning },
                          numberOfHours: l.hours,
                          rate: {
                            rateValue: minorToDecimal(l.rateMinor, handoff.exponent),
                            currencyCode: l.currencyCode,
                          },
                        })),
                      },
                    ],
                  })),
                },
              },
            },
          },
        ],
      },
    });
    const id = response.events?.[0]?.eventID;
    if (id === undefined)
      throw new IntegrationError("provider_malformed_response", "ADP did not return the event id.");
    return { reference: id, version: null };
  },
};

// Rippling ---------------------------------------------------------------------------------------------------------------

export const ripplingProvider: PayrollProvider = {
  provider: "rippling",
  label: "Rippling",
  async handoff(context, handoff) {
    const response = await callJson<{ id: string }>(context.http, "Rippling", {
      method: "POST",
      url: "https://api.rippling.com/platform/api/payroll/earning_imports",
      token: token(context),
      json: {
        pay_period: { start_date: handoff.periodStart, end_date: handoff.periodEnd },
        earnings: handoff.lines.map((l) => ({
          employee_id: l.employeeId,
          earning_type: l.providerEarning,
          hours: l.hours,
          rate: minorToDecimal(l.rateMinor, handoff.exponent),
          amount: minorToDecimal(l.amountMinor, handoff.exponent),
          currency: l.currencyCode,
        })),
      },
    });
    return { reference: response.id, version: null };
  },
};

// Connector --------------------------------------------------------------------------------------------------------------

/**
 * Hands one exported payroll run to the provider. Every employee and earning code must be mapped:
 * payroll is never sent partially, so any gap fails the run with an item error per gap.
 */
export function payrollConnector(provider: PayrollProvider, source: PayrollSource): Connector {
  return {
    provider: provider.provider,
    scopes: ["Payroll Export"],
    async sync(context) {
      const { run, connection, store } = context;
      if (run.subjectEntity !== "Payroll Run" || run.subjectId === null) {
        throw new IntegrationError(
          "payroll_subject_missing",
          "A payroll handoff names the payroll run it hands off.",
        );
      }
      const tally = new ItemTally(context);
      const file = await source.handoffFile(connection.id, run.subjectId);
      const done = (await store.externalIds(connection.id, "Payroll Run")).find(
        (x) => x.localId === run.subjectId,
      );
      if (done?.contentHash === file.checksum) {
        tally.read = 1;
        tally.skipped = 1;
        return { counts: tally.counts(), cursorAfter: context.cursor };
      }
      const lines = parsePayrollCsv(file.content);
      const employees = new Map(
        (await store.externalIds(connection.id, "Membership")).map((x) => [
          x.localId,
          x.externalId,
        ]),
      );
      const earningIds = await source.earningCodeIds(connection.orgId);
      const earnings = new Map(
        (await store.externalIds(connection.id, "Earning Code")).map((x) => [
          x.localId,
          x.externalId,
        ]),
      );
      const mapped: MappedLine[] = [];
      for (const line of lines) {
        tally.read += 1;
        const employeeId = employees.get(line.membershipId);
        const earningId = earningIds.get(line.earningCode);
        const providerEarning = earningId === undefined ? undefined : earnings.get(earningId);
        if (employeeId === undefined) {
          await tally.fail(
            "employee_unmapped",
            `No ${provider.label} employee is mapped for this crew member.`,
            { entity: "Membership", localId: line.membershipId },
          );
        } else if (providerEarning === undefined) {
          await tally.fail(
            "earning_code_unmapped",
            `Earning code ${line.earningCode} has no ${provider.label} earning mapped.`,
            {
              entity: "Earning Code",
              ...(earningId === undefined ? {} : { localId: earningId }),
            },
          );
        } else {
          mapped.push({ ...line, employeeId, providerEarning });
        }
      }
      if (tally.failed > 0) {
        throw new IntegrationError(
          "payroll_mapping_incomplete",
          `${tally.failed} payroll lines are not mapped; nothing was sent to ${provider.label}.`,
        );
      }
      const currency = mapped[0]?.currencyCode ?? lines[0]?.currencyCode;
      const exponent = currency === undefined ? 2 : await source.exponentOf(currency);
      const result = await provider.handoff(context, {
        lines: mapped,
        periodStart: file.periodStart,
        periodEnd: file.periodEnd,
        exponent,
      });
      await store.upsertExternalId(connection.id, {
        entity: "Payroll Run",
        localId: run.subjectId,
        externalId: result.reference,
        externalVersion: result.version,
        contentHash: file.checksum,
      });
      tally.written = mapped.length;
      return { counts: tally.counts(), cursorAfter: context.cursor };
    },
  };
}

export function payrollConnectors(source: PayrollSource): Connector[] {
  return [gustoProvider, adpProvider, ripplingProvider].map((p) => payrollConnector(p, source));
}

export function supabasePayrollSource(db: DbClient): PayrollSource {
  return {
    async handoffFile(connectionId, payrollRunId) {
      const rows = await unwrap<
        {
          payroll_export_id: string;
          checksum_sha256: string;
          content: string;
          pay_period_start: string;
          pay_period_end: string;
        }[]
      >(
        db.rpc("payroll_export_for_handoff", {
          p_connection_id: connectionId,
          p_payroll_run_id: payrollRunId,
        }),
      );
      const row = rows[0];
      if (row === undefined)
        throw new IntegrationError(
          "payroll_export_missing",
          "No export of this run was produced for this provider.",
        );
      return {
        exportId: row.payroll_export_id,
        checksum: row.checksum_sha256,
        content: row.content,
        periodStart: row.pay_period_start,
        periodEnd: row.pay_period_end,
      };
    },
    async earningCodeIds(orgId) {
      const rows = await unwrap<{ id: string; code: string }[]>(
        db.from("earning_codes").select("id, code").eq("org_id", orgId).is("deleted_at", null),
      );
      return new Map(rows.map((r) => [r.code, r.id]));
    },
    async exponentOf(currencyCode) {
      const row = await unwrap<{ minor_unit_exponent: number } | null>(
        db
          .from("currencies")
          .select("minor_unit_exponent")
          .eq("currency_code", currencyCode)
          .maybeSingle(),
      );
      if (row === null)
        throw new IntegrationError(
          "currency_unknown",
          `${currencyCode} is not an ISO 4217 currency the database knows.`,
        );
      return row.minor_unit_exponent;
    },
  };
}
