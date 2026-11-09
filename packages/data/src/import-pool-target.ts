import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CellIssue,
  ImportStore,
  PoolInvitationContext,
  TargetLookups,
  ValidRow,
} from "./import-worker.ts";
import { parseRate, rateTypeOf } from "./import-rate.ts";

/**
 * The pool_invitations import target (B10, G-132, 6526): checking a row and updating a pending invitation. Its own module,
 * loaded only for this target, because import-run's boot has a ceiling. The phone library loads later still, only when a
 * row has a phone. Rows invite an address into a Talent pool and never write a person or a profile: the strong key is the
 * email inside the row's pool, a pending match is updated with no new email, an expired match is reissued, and a decided
 * Merged review skips the row.
 */

type Row = Record<string, unknown>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** How long a reissued pool invitation stays open: the default of app.invite_to_talent_pool. */
const POOL_INVITATION_DAYS = 30;

export async function checkPoolInvitationRow(input: {
  readonly orgId: string;
  readonly raw: Readonly<Record<string, { value: string; column: number }>>;
  readonly columnOf: (field: string) => number;
  readonly pools: PoolInvitationContext | undefined;
  readonly lookups: TargetLookups;
  readonly values: Row;
  readonly issues: CellIssue[];
}): Promise<void> {
  const { orgId, raw, columnOf, pools, lookups, values, issues } = input;
  const text = (field: string) => raw[field]?.value.trim() ?? "";
  const email = text("email").toLowerCase();
  if (email) {
    if (EMAIL.test(email) && email.length <= 320) values["email"] = email;
    else issues.push({ columnIndex: columnOf("email"), issue: "invalid_email" });
  }
  const poolName = text("pool_name");
  if (poolName) {
    const pool = await lookups.talentPoolIdByName(orgId, poolName);
    if (pool) values["talent_pool_id"] = pool;
    else issues.push({ columnIndex: columnOf("pool_name"), issue: "unknown_pool" });
  } else if (pools?.talentPoolId) {
    values["talent_pool_id"] = pools.talentPoolId;
  } else {
    issues.push({ columnIndex: columnOf("pool_name"), issue: "pool_required" });
  }
  const name = text("invitee_name");
  if (name.length > 200) issues.push({ columnIndex: columnOf("invitee_name"), issue: "too_long" });
  else if (name) values["invitee_name"] = name;
  const note = text("note");
  if (note.length > 1000) issues.push({ columnIndex: columnOf("note"), issue: "too_long" });
  else if (note) values["note"] = note;
  const phone = text("work_phone");
  if (phone) {
    // The phone metadata is about 80 KB: it loads only for a file with a phone in it.
    const { regionFromLocale, toE164 } = await import("@xos/i18n/phone");
    const e164 = toE164(phone, pools?.language ? regionFromLocale(pools.language) : null);
    if (e164) values["work_phone"] = e164;
    else issues.push({ columnIndex: columnOf("work_phone"), issue: "invalid_phone" });
  }
  const role = text("role");
  if (role) {
    const code = await lookups.roleCode(role);
    if (code) values["role_code"] = code;
    else issues.push({ columnIndex: columnOf("role"), issue: "unknown_role" });
  }
  checkRate(raw, columnOf, pools, values, issues);
}

/** A row's standing rate from the rate, rate_currency and rate_type cells, through the import's number format. */
function checkRate(
  raw: Readonly<Record<string, { value: string; column: number }>>,
  columnOf: (field: string) => number,
  pools: PoolInvitationContext | undefined,
  values: Row,
  issues: CellIssue[],
): void {
  const rate = raw["rate"]?.value.trim() ?? "";
  if (!rate) return;
  const column = columnOf("rate");
  if (!pools?.canWriteRates) {
    issues.push({ columnIndex: column, issue: "rate_not_permitted" });
    return;
  }
  const parsed = parseRate(
    rate,
    pools.numberFormat,
    (code) => pools.exponents.get(code),
    pools.baseCurrency,
    raw["rate_currency"]?.value ?? null,
  );
  if (!parsed.ok) {
    issues.push({ columnIndex: column, issue: parsed.issue });
    return;
  }
  const cell = raw["rate_type"]?.value.trim() ?? "";
  const named = cell ? rateTypeOf(cell) : null;
  if (cell && named === null) {
    issues.push({ columnIndex: columnOf("rate_type"), issue: "rate_type_required" });
    return;
  }
  if (parsed.basis && named && parsed.basis !== named) {
    issues.push({ columnIndex: column, issue: "rate_type_conflict" });
    return;
  }
  const basis = parsed.basis ?? named;
  if (basis === null) {
    issues.push({ columnIndex: column, issue: "rate_type_required" });
    return;
  }
  values["rate_minor"] = parsed.minor;
  values["currency_code"] = parsed.currency;
  values["rate_type"] = basis;
}

/**
 * A pool invitation row with a match. A strong-key match is a pending invitation: its fields are updated with no new email, and an expired one
 * is reissued, which queues the email. The rate is set only when the invitation has none: the update's before image is
 * readable by every pool writer, so a rate that is already there never reaches it, and the row result says so.
 */
export async function commitPoolMatch(input: {
  readonly store: ImportStore;
  readonly batchId: string;
  readonly valid: ValidRow;
  readonly values: Row;
  readonly refuse: (message: string) => Error;
}): Promise<void> {
  const { store, batchId, valid } = input;
  const rowId = valid.id;
  // A decided Merged review means the person is already invited or in a pool, and the candidate may be a pool member, so
  // nothing is written. Kept Separate never gets here: it has no target and creates a new invitation.
  if (valid.mergeInto) {
    await store.skipRow(rowId, "pool_merged_in_review");
    return;
  }
  const target = valid.matchedId as string;
  const existing = await store.lookups.poolInvitation(target);
  if (existing === null) throw input.refuse("The invitation to update no longer exists.");
  const { rate_minor: rate, rate_type: basis, currency_code: currency, ...rest } = input.values;
  const changes: Row = { ...rest };
  const keptRate = existing.hasRate && rate !== undefined;
  if (!existing.hasRate && rate !== undefined) {
    changes["rate_minor"] = rate;
    changes["rate_type"] = basis;
    changes["currency_code"] = currency;
  }
  if (new Date(existing.expiresAt).getTime() <= Date.now()) {
    changes["expires_at"] = new Date(Date.now() + POOL_INVITATION_DAYS * 86_400_000).toISOString();
  }
  const before = await store.lookups.update("pool_invitations", target, changes);
  await store.commitWrite({ rowId, batchId, targetId: target, action: "Updated", before });
  if (keptRate) await store.noteRow(rowId, "pool_rate_kept");
}

/** The store's reads for this target, over the service role client of supabaseImportStore. */
export function poolLookups(deps: {
  readonly app: ReturnType<SupabaseClient["schema"]>;
  readonly canon: ReturnType<SupabaseClient["schema"]>;
  readonly call: (fn: string, args: Row) => Promise<unknown>;
  readonly one: (
    query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
    what: string,
  ) => Promise<Row | null>;
  readonly onlyMatch: (rows: readonly Row[], name: string, ...keys: string[]) => string | null;
  readonly text: (row: Row | null | undefined, key: string) => string;
}): Pick<
  TargetLookups,
  "talentPoolIdByName" | "roleCode" | "poolInvitationContext" | "poolInvitation"
> {
  const { app, canon, call, one, onlyMatch, text } = deps;
  return {
    async talentPoolIdByName(orgId, name) {
      const { data, error } = await app
        .from("talent_pools")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("pool_kind", "Talent")
        .is("deleted_at", null);
      if (error) throw new Error(`talent_pools: ${error.message}`);
      return onlyMatch((data as Row[] | null) ?? [], name, "name");
    },
    async roleCode(codeOrTitle) {
      const wanted = codeOrTitle.trim();
      const byCode = await one(
        canon.from("role").select("role_code").eq("role_code", wanted).limit(1),
        "role",
      );
      if (byCode) return text(byCode, "role_code");
      const { data, error } = await canon
        .from("role")
        .select("role_code, job_title")
        .ilike("job_title", wanted.replace(/[%_\\]/g, "\\$&"));
      if (error) throw new Error(`role: ${error.message}`);
      const rows = (data as Row[] | null) ?? [];
      return rows.length === 1 ? text(rows[0], "role_code") : null;
    },
    async poolInvitationContext(job) {
      const [can, defaults, currencies] = await Promise.all([
        call("import_job_can_write_rates", { p_import_job_id: job.id }),
        call("import_job_org_defaults", { p_import_job_id: job.id }),
        app.from("currencies").select("currency_code, minor_unit_exponent"),
      ]);
      if (currencies.error) throw new Error(`currencies: ${currencies.error.message}`);
      const org = ((defaults as Row[] | null) ?? [])[0];
      return {
        talentPoolId: job.talentPoolId ?? null,
        numberFormat: job.numberFormat ?? "comma-dot",
        canWriteRates: can === true,
        language: typeof org?.["language"] === "string" ? org["language"] : null,
        baseCurrency: typeof org?.["base_currency"] === "string" ? org["base_currency"] : null,
        exponents: new Map(
          ((currencies.data as Row[] | null) ?? []).map((c) => [
            text(c, "currency_code").trim(),
            Number(c["minor_unit_exponent"]),
          ]),
        ),
      };
    },
    async poolInvitation(id) {
      const row = await one(
        app
          .from("talent_pool_invitations")
          .select("expires_at, rate_minor")
          .eq("id", id)
          .is("claimed_at", null)
          .is("declined_at", null)
          .is("revoked_at", null)
          .is("deleted_at", null),
        "talent_pool_invitations",
      );
      return row
        ? { expiresAt: text(row, "expires_at"), hasRate: row["rate_minor"] !== null }
        : null;
    },
  };
}
