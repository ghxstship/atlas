import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import {
  CALENDAR_FEEDS_MIRROR,
  feedErrorKey,
  feedItems,
  issuedLink,
  readMyFeeds,
  type FeedRow,
} from "../src/settings/calendar-feeds";
import {
  CONNECTED_APPS_MIRROR,
  grantItems,
  readMyGrants,
  revokeErrorKey,
  scopeList,
  type GrantRow,
} from "../src/settings/connected-apps";
import {
  createTokenUrl,
  PERSONAL_TOKENS_MIRROR,
  readMyTokens,
  readTokensAllowed,
  revokeOutcome,
  tokenItems,
  tokenStanding,
  type TokenRow,
} from "../src/settings/developer";
import {
  addressInput,
  addressStanding,
  checkTaxAddress,
  enumLabel,
  giveTaxFormUrl,
  PAYOUT_TAX_MIRROR,
  payoutItems,
  readMyPayouts,
  readMyTaxForms,
  sameAddress,
  taxAddressRuleKey,
  taxAddressWrite,
  taxFormItems,
  type TaxFormRow,
} from "../src/settings/payout-tax";

/**
 * Settings, Payout and Tax, Calendar Feeds, Connected Apps and Developer in Compass (A112, ADR 0072): the reads go
 * through the @xos/data functions Gateway uses and keep only what the device may hold, the checks match Gateway's
 * forms, and the one queued write (the W-9 address) is a replay-safe RPC.
 */

type Answer = { readonly data: unknown; readonly error: { code?: string; message: string } | null };

/**
 * A Supabase client over fixed answers, keyed by table ("api_external.tax_forms", "person_calendar_feeds") or RPC
 * ("rpc:my_oauth_apps"). `eq` and `is` filter an array answer the way PostgREST would, so a read that asks for one
 * person's rows gets only those.
 */
function fakeClient(answers: Readonly<Record<string, Answer>>) {
  const calls: string[] = [];
  const query = (key: string) => {
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const builder: Record<string, unknown> = {};
    const chain =
      (name: string, filter?: (...args: unknown[]) => (row: Record<string, unknown>) => boolean) =>
      (...args: unknown[]) => {
        calls.push(`${key}.${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        if (filter) filters.push(filter(...args));
        return builder;
      };
    builder["select"] = chain("select");
    builder["order"] = chain("order");
    builder["eq"] = chain("eq", (col, value) => (row) => row[col as string] === value);
    builder["is"] = chain("is", (col, value) => (row) => (row[col as string] ?? null) === value);
    builder["then"] = (resolve: (a: Answer) => unknown, reject: (e: unknown) => unknown) => {
      const answer = answers[key] ?? { data: [], error: null };
      const data = Array.isArray(answer.data)
        ? (answer.data as Record<string, unknown>[]).filter((row) => filters.every((f) => f(row)))
        : answer.data;
      return Promise.resolve({ ...answer, data }).then(resolve, reject);
    };
    return builder;
  };
  const client = {
    from: (table: string) => query(table),
    schema: (schema: string) => ({ from: (table: string) => query(`${schema}.${table}`) }),
    rpc: (fn: string) => {
      calls.push(`rpc:${fn}`);
      return Promise.resolve(answers[`rpc:${fn}`] ?? { data: [], error: null });
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const failed: Answer = { data: null, error: { code: "PGRST000", message: "offline" } };

const ME = "0193a000-0000-7000-8000-000000000001";
const ACCOUNT = "0193a000-0000-7000-8000-0000000000ac";
const ORG_A = "0193a000-0000-7000-8000-00000000000a";
const ORG_B = "0193a000-0000-7000-8000-00000000000b";

/** The message at a dotted key of a locale's catalog, or undefined. */
function message(locale: "en-US" | "es-US", key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      getMessages(locale),
    );
}

function expectMessage(key: string) {
  for (const locale of ["en-US", "es-US"] as const) {
    expect(typeof message(locale, key), `${locale} ${key}`).toBe("string");
  }
}

// Payout and Tax ---------------------------------------------------------------------------------------------------

const taxForm = (over: Partial<TaxFormRow> = {}): TaxFormRow => ({
  id: "0193a000-0000-7000-8000-0000000000f1",
  orgId: ORG_A,
  orgName: "Aurora Live",
  kind: "W-9",
  tinLast4: "6789",
  withholding: false,
  signedAt: "2026-09-01T12:00:00Z",
  legalName: null,
  streetAddress: null,
  locality: null,
  regionCode: null,
  postalCode: null,
  ...over,
});

describe("Payout and Tax reads", () => {
  it("keeps only the person's own payout destinations, with the provider and last four", async () => {
    const { client, calls } = fakeClient({
      "api_external.payout_accounts": {
        data: [
          {
            id: "p1",
            org_id: ORG_A,
            person_id: ME,
            account_id: null,
            provider: "Stripe Connect",
            account_last4: "4242",
          },
          {
            id: "p2",
            org_id: ORG_B,
            person_id: null,
            account_id: ACCOUNT,
            provider: "Accounting System",
            account_last4: null,
          },
        ],
        error: null,
      },
    });
    expect(await readMyPayouts(client, ME)).toEqual([
      { id: "p1", orgId: ORG_A, provider: "Stripe Connect", last4: "4242" },
    ]);
    expect(calls[0]).toMatch(/^api_external\.payout_accounts\.select/);
  });

  it("returns null when the read fails, so the device keeps what it had", async () => {
    const { client } = fakeClient({ "api_external.payout_accounts": failed });
    expect(await readMyPayouts(client, ME)).toBeNull();
  });

  it("joins each W-9 with its name and address and leaves out a company account's forms", async () => {
    const base = {
      org_name: "Aurora Live",
      account_id: null,
      tin_last4: "6789",
      foreign_performer_withholding: false,
      legal_name: null,
      street_address: null,
      locality: null,
      region_code: null,
      postal_code: null,
    };
    const { client } = fakeClient({
      "api_external.tax_forms": {
        data: [
          {
            ...base,
            id: "w9",
            org_id: ORG_A,
            person_id: ME,
            form_kind: "W-9",
            signed_at: "2026-09-01T12:00:00Z",
            legal_name: "Dana Reyes",
            street_address: "1 Main St",
            locality: "Austin",
            region_code: "TX",
            postal_code: "78701",
          },
          {
            ...base,
            id: "w8",
            org_id: ORG_B,
            org_name: "Harbor Fest",
            person_id: ME,
            form_kind: "W-8BEN",
            signed_at: "2026-10-01T12:00:00Z",
            foreign_performer_withholding: true,
          },
          {
            ...base,
            id: "company",
            org_id: ORG_B,
            person_id: null,
            account_id: ACCOUNT,
            form_kind: "W-9",
            signed_at: "2026-08-01T12:00:00Z",
          },
        ],
        error: null,
      },
    });
    const forms = await readMyTaxForms(client, ME);
    expect(forms?.map((f) => f.id)).toEqual(["w9", "w8"]);
    expect(forms?.[0]).toMatchObject({
      kind: "W-9",
      legalName: "Dana Reyes",
      streetAddress: "1 Main St",
      locality: "Austin",
      regionCode: "TX",
      postalCode: "78701",
    });
    expect(forms?.[1]).toMatchObject({ kind: "W-8BEN", withholding: true, streetAddress: null });
    // Only the last four of the identifier ever reaches the device.
    expect(Object.keys(forms?.[0] ?? {})).not.toContain("tin");
  });

  it("returns null when either tax form read fails", async () => {
    const { client } = fakeClient({ "api_external.tax_forms": failed });
    expect(await readMyTaxForms(client, ME)).toBeNull();
  });
});

describe("Payout and Tax view", () => {
  it("names each paying org from the person's orgs, else from a tax form, unnamed last", () => {
    const items = payoutItems(
      [
        { id: "p3", orgId: "unknown", provider: "Stripe Connect", last4: "1111" },
        { id: "p2", orgId: ORG_B, provider: "Accounting System", last4: null },
        { id: "p1", orgId: ORG_A, provider: "Stripe Connect", last4: "4242" },
      ],
      new Map([[ORG_B, "Harbor Fest"]]),
      [taxForm()],
    );
    expect(items).toEqual([
      {
        id: "p1",
        orgName: "Aurora Live",
        providerKey: "gateway.enums.payoutProvider.stripeConnect",
        last4: "4242",
      },
      {
        id: "p2",
        orgName: "Harbor Fest",
        providerKey: "gateway.enums.payoutProvider.accountingSystem",
        last4: null,
      },
      {
        id: "p3",
        orgName: null,
        providerKey: "gateway.enums.payoutProvider.stripeConnect",
        last4: "1111",
      },
    ]);
    for (const item of items) expectMessage(item.providerKey);
  });

  it("labels every tax form kind with Gateway's enum labels", () => {
    for (const kind of ["W-9", "W-8BEN", "W-8BEN-E"]) expectMessage(enumLabel("taxFormKind", kind));
    expect(enumLabel("taxFormKind", "W-8BEN-E")).toBe("gateway.enums.taxFormKind.w8benE");
  });

  it("lists tax forms newest first", () => {
    const old = taxForm({ id: "old", signedAt: "2025-01-01T00:00:00Z" });
    const recent = taxForm({ id: "new", signedAt: "2026-10-01T00:00:00Z" });
    expect(taxFormItems([old, recent]).map((f) => f.id)).toEqual(["new", "old"]);
  });

  it("asks a W-9 for its mailing address until every line is there, and never a W-8", () => {
    expect(addressStanding(taxForm())).toBe("needed");
    expect(addressStanding(taxForm({ streetAddress: "1 Main St", locality: "Austin" }))).toBe(
      "needed",
    );
    expect(
      addressStanding(
        taxForm({
          streetAddress: "1 Main St",
          locality: "Austin",
          regionCode: "TX",
          postalCode: "78701",
        }),
      ),
    ).toBe("complete");
    expect(addressStanding(taxForm({ kind: "W-8BEN" }))).toBe("none");
  });

  it("opens Gateway's engagements to give a tax form", () => {
    expect(giveTaxFormUrl("https://gateway.ghxstship.tech/")).toBe(
      "https://gateway.ghxstship.tech/work/engagements",
    );
  });
});

describe("W-9 address", () => {
  const typed = {
    legalName: "  ",
    streetAddress: " 1 Main St ",
    locality: "Austin ",
    regionCode: "tx",
    postalCode: "78701-1234",
  };

  it("trims the values, upper-cases the state and reads a blank name as the person's own", () => {
    expect(checkTaxAddress(typed)).toEqual({
      ok: true,
      value: {
        legalName: null,
        streetAddress: "1 Main St",
        locality: "Austin",
        regionCode: "TX",
        postalCode: "78701-1234",
      },
    });
  });

  it("names the field and Gateway's message for each value it refuses", () => {
    const result = checkTaxAddress({
      legalName: "x".repeat(201),
      streetAddress: "",
      locality: "y".repeat(101),
      regionCode: "Texas",
      postalCode: "7870",
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        legalName: "payouts.w9.errors.legalName",
        streetAddress: "payouts.w9.errors.streetAddress",
        locality: "payouts.w9.errors.locality",
        regionCode: "payouts.w9.errors.regionCode",
        postalCode: "payouts.w9.errors.postalCode",
      },
    });
    if (!result.ok) for (const key of Object.values(result.errors)) expectMessage(key);
  });

  it("starts the form from the address the W-9 holds", () => {
    expect(addressInput(taxForm({ legalName: "Dana Reyes", regionCode: "TX" }))).toEqual({
      legalName: "Dana Reyes",
      streetAddress: "",
      locality: "",
      regionCode: "TX",
      postalCode: "",
    });
  });

  it("sees nothing to save when the address is the one on the form", () => {
    const form = taxForm({
      streetAddress: "1 Main St",
      locality: "Austin",
      regionCode: "TX",
      postalCode: "78701",
    });
    const checked = checkTaxAddress(addressInput(form));
    expect(checked.ok && sameAddress(form, checked.value)).toBe(true);
    const moved = checkTaxAddress({ ...addressInput(form), streetAddress: "2 Main St" });
    expect(moved.ok && sameAddress(form, moved.value)).toBe(false);
  });

  it("queues app.set_tax_form_address with the payee's values and lays them on the device copy", () => {
    const form = taxForm();
    const checked = checkTaxAddress(typed);
    if (!checked.ok) throw new Error("expected a valid address");
    expect(taxAddressWrite(form, checked.value)).toEqual({
      op: "rpc",
      target: "set_tax_form_address",
      table: PAYOUT_TAX_MIRROR.taxForms,
      rowId: form.id,
      payload: {
        p_tax_form_id: form.id,
        p_legal_name: "",
        p_street_address: "1 Main St",
        p_locality: "Austin",
        p_region_code: "TX",
        p_postal_code: "78701-1234",
      },
      policy: "append",
      optimistic: { ...form, ...checked.value },
    });
  });

  it("names the database's incomplete-address refusal and leaves the rest to the server's sentence", () => {
    expect(taxAddressRuleKey("tax_form_address_incomplete")).toBe(
      "compassSettings.payoutTax.addressIncomplete",
    );
    expect(taxAddressRuleKey("anything_else")).toBeUndefined();
  });
});

// Calendar Feeds ---------------------------------------------------------------------------------------------------

describe("Calendar Feeds", () => {
  it("reads the person's live feeds without their tokens", async () => {
    const { client, calls } = fakeClient({
      person_calendar_feeds: {
        data: [
          {
            id: "f1",
            token_hint: "a1b2",
            created_at: "2026-10-01T00:00:00Z",
            rotated_at: null,
            last_accessed_at: "2026-10-20T00:00:00Z",
            revoked_at: null,
            deleted_at: null,
          },
          {
            id: "gone",
            token_hint: "dead",
            created_at: "2026-09-01T00:00:00Z",
            rotated_at: null,
            last_accessed_at: null,
            revoked_at: "2026-09-02T00:00:00Z",
            deleted_at: null,
          },
        ],
        error: null,
      },
    });
    const feeds = await readMyFeeds(client);
    expect(feeds).toEqual([
      {
        id: "f1",
        tokenHint: "a1b2",
        createdAt: "2026-10-01T00:00:00Z",
        rotatedAt: null,
        lastAccessedAt: "2026-10-20T00:00:00Z",
      },
    ]);
    expect(calls.some((c) => c.startsWith('person_calendar_feeds.is("revoked_at"'))).toBe(true);
    expect(CALENDAR_FEEDS_MIRROR.startsWith("_")).toBe(true);
  });

  it("returns null when the read fails", async () => {
    expect(await readMyFeeds(fakeClient({ person_calendar_feeds: failed }).client)).toBeNull();
  });

  it("lists feeds newest first", () => {
    const feed = (id: string, createdAt: string): FeedRow => ({
      id,
      tokenHint: id,
      createdAt,
      rotatedAt: null,
      lastAccessedAt: null,
    });
    expect(
      feedItems([feed("old", "2026-01-01T00:00:00Z"), feed("new", "2026-10-01T00:00:00Z")]).map(
        (f) => f.id,
      ),
    ).toEqual(["new", "old"]);
  });

  it("builds the link on Gateway's origin, with its webcal form for the calendar app", () => {
    const token = `xcal_${"ab".repeat(32)}`;
    expect(issuedLink("https://gateway.ghxstship.tech/", "f1", token)).toEqual({
      feedId: "f1",
      url: `https://gateway.ghxstship.tech/ical/${token}.ics`,
      webcal: `webcal://gateway.ghxstship.tech/ical/${token}.ics`,
    });
  });

  it("names Gateway's refusals: the 20-feed limit, a feed not available, anything else", () => {
    const limit = feedErrorKey({ kind: "refusal", rule: "calendar_feed_limit", message: "" });
    const denied = feedErrorKey({ kind: "not-found" });
    const other = feedErrorKey({ kind: "unexpected", message: "network" });
    expect([limit, denied, other]).toEqual([
      "gateway.settings.calendarFeeds.errors.calendar_feed_limit",
      "gateway.settings.calendarFeeds.errors.denied",
      "gateway.settings.calendarFeeds.errors.unexpected",
    ]);
    expect(feedErrorKey({ kind: "refusal", rule: "calendar_feed_revoked", message: "" })).toBe(
      other,
    );
    for (const key of [limit, denied, other]) expectMessage(key);
  });
});

// Connected Apps ---------------------------------------------------------------------------------------------------

describe("Connected Apps", () => {
  it("reads each live grant from app.my_oauth_apps, keyed by the grant", async () => {
    const { client, calls } = fakeClient({
      "rpc:my_oauth_apps": {
        data: [
          {
            grant_id: "g1",
            oauth_app_id: "app1",
            app_name: "Crew Sync",
            org_name: "Aurora Live",
            scopes: ["schedule", "crew"],
            granted_at: "2026-10-02T00:00:00Z",
            last_used_at: null,
          },
        ],
        error: null,
      },
    });
    expect(await readMyGrants(client)).toEqual([
      {
        id: "g1",
        appName: "Crew Sync",
        orgName: "Aurora Live",
        scopes: ["schedule", "crew"],
        grantedAt: "2026-10-02T00:00:00Z",
        lastUsedAt: null,
      },
    ]);
    expect(calls).toEqual(["rpc:my_oauth_apps"]);
    expect(CONNECTED_APPS_MIRROR.startsWith("_")).toBe(true);
  });

  it("returns null when the read fails", async () => {
    expect(await readMyGrants(fakeClient({ "rpc:my_oauth_apps": failed }).client)).toBeNull();
  });

  it("lists grants newest first with their areas sorted", () => {
    const grant = (id: string, grantedAt: string): GrantRow => ({
      id,
      appName: id,
      orgName: "Aurora Live",
      scopes: [],
      grantedAt,
      lastUsedAt: null,
    });
    expect(
      grantItems([grant("old", "2026-01-01T00:00:00Z"), grant("new", "2026-10-01T00:00:00Z")]).map(
        (g) => g.id,
      ),
    ).toEqual(["new", "old"]);
    expect(scopeList(["schedule", "crew", "assets"])).toBe("assets, crew, schedule");
  });

  it("reads a grant already gone as not available and anything else as a failure", () => {
    expect(revokeErrorKey({ kind: "not-found" })).toBe("compassSettings.connections.gone");
    expect(revokeErrorKey({ kind: "unexpected", message: "network" })).toBe(
      "compassSettings.common.failed",
    );
  });
});

// Developer --------------------------------------------------------------------------------------------------------

const token = (over: Partial<TokenRow> = {}): TokenRow => ({
  id: "t1",
  orgId: ORG_A,
  orgName: "Aurora Live",
  name: "Laptop script",
  prefix: "xos_pat_ab12",
  scopes: ["schedule"],
  expiresAt: "2026-12-01T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

describe("Developer", () => {
  it("reads the person's own tokens in every org, with live scopes only", async () => {
    const { client, calls } = fakeClient({
      personal_access_tokens: {
        data: [
          {
            id: "t1",
            org_id: ORG_A,
            person_id: ME,
            name: "Laptop script",
            prefix: "xos_pat_ab12",
            expires_at: "2026-12-01T00:00:00Z",
            last_used_at: null,
            revoked_at: null,
            deleted_at: null,
            organizations: { name: "Aurora Live" },
            personal_access_token_scopes: [
              { scope: "schedule", deleted_at: null },
              { scope: "crew", deleted_at: "2026-10-01T00:00:00Z" },
            ],
          },
          {
            id: "someone-else",
            org_id: ORG_A,
            person_id: "other",
            name: "Not mine",
            prefix: "xos_pat_zz99",
            expires_at: "2026-12-01T00:00:00Z",
            last_used_at: null,
            revoked_at: null,
            deleted_at: null,
            organizations: { name: "Aurora Live" },
            personal_access_token_scopes: [],
          },
        ],
        error: null,
      },
    });
    expect(await readMyTokens(client, ME)).toEqual([token()]);
    expect(calls).toContain(`personal_access_tokens.eq("person_id","${ME}")`);
    expect(PERSONAL_TOKENS_MIRROR.startsWith("_")).toBe(true);
  });

  it("returns null when the read fails", async () => {
    expect(
      await readMyTokens(fakeClient({ personal_access_tokens: failed }).client, ME),
    ).toBeNull();
  });

  it("knows whether an org lets the person create a token, or that it cannot tell", async () => {
    const yes = fakeClient({
      "rpc:my_orgs_allowing_personal_tokens": {
        data: [{ org_id: ORG_A, org_name: "Aurora Live" }],
        error: null,
      },
    });
    const no = fakeClient({ "rpc:my_orgs_allowing_personal_tokens": { data: [], error: null } });
    const unknown = fakeClient({ "rpc:my_orgs_allowing_personal_tokens": failed });
    expect(await readTokensAllowed(yes.client)).toBe(true);
    expect(await readTokensAllowed(no.client)).toBe(false);
    expect(await readTokensAllowed(unknown.client)).toBeNull();
  });

  it("tags a token revoked, then expired by its date, else active, and offers revoke until revoked", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    expect(tokenStanding(token(), now)).toBe("active");
    expect(tokenStanding(token({ expiresAt: "2026-10-23T00:00:00Z" }), now)).toBe("expired");
    expect(
      tokenStanding(
        token({ expiresAt: "2026-10-23T00:00:00Z", revokedAt: "2026-10-01T00:00:00Z" }),
        now,
      ),
    ).toBe("revoked");
    expect(
      tokenItems([token(), token({ id: "t2", revokedAt: "2026-10-01T00:00:00Z" })], now).map(
        (i) => [i.token.id, i.standing, i.revocable],
      ),
    ).toEqual([
      ["t1", "active", true],
      ["t2", "revoked", false],
    ]);
    for (const key of ["active", "expired", "revoked"]) expectMessage(`settingsSurfaces.${key}`);
  });

  it("reads a token revoked elsewhere as done, a token gone as gone, anything else as failed", () => {
    expect(revokeOutcome({ kind: "refusal", rule: "personal_token_revoked", message: "" })).toBe(
      "done",
    );
    expect(revokeOutcome({ kind: "not-found" })).toBe("gone");
    expect(revokeOutcome({ kind: "refusal", rule: "step_up_required", message: "" })).toBe(
      "failed",
    );
  });

  it("creates a token in Gateway's Developer section", () => {
    expect(createTokenUrl("https://gateway.ghxstship.tech")).toBe(
      "https://gateway.ghxstship.tech/settings/developer",
    );
  });
});

// Copy -------------------------------------------------------------------------------------------------------------

describe("copy of the four screens", () => {
  const files = [
    "app/settings/payout-and-tax.tsx",
    "app/settings/calendar-feeds.tsx",
    "app/settings/connected-apps.tsx",
    "app/settings/developer.tsx",
    "src/screens/settings/ConnectionParts.tsx",
  ];

  /**
   * Every message key a screen names: quoted keys of the catalogs it reads, and keys built from its namespace
   * constant (const C = "gateway.settings.calendarFeeds"; `${C}.add`). A key finished at runtime from a value is
   * listed with its values below.
   */
  function keysOf(file: string): string[] {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const constants = new Map(
      [...source.matchAll(/^\s*const ([A-Z]) = "([A-Za-z.]+)";$/gm)].map((m) => [m[1], m[2]]),
    );
    const quoted = [
      ...source.matchAll(
        /["`]((?:compass|compassSettings|gateway|settingsSurfaces|payouts|nav)\.[A-Za-z0-9_.]+)["`]/g,
      ),
    ]
      .map((m) => m[1] as string)
      .filter((key) => ![...constants.values()].includes(key));
    const built = [...source.matchAll(/`\$\{([A-Z])\}\.([A-Za-z0-9_.]+)(`|\$)/g)]
      .filter((m) => m[3] === "`" && constants.has(m[1] as string))
      .map((m) => `${constants.get(m[1] as string)}.${m[2]}`);
    return [...quoted, ...built];
  }

  it("names only keys that exist in English and Spanish", () => {
    const keys = new Set([
      ...files.flatMap(keysOf),
      "compassSettings.payoutTax.address.needed",
      "compassSettings.payoutTax.address.complete",
      "compassSettings.payoutTax.addressIncomplete",
      "settingsSurfaces.active",
      "settingsSurfaces.expired",
      "settingsSurfaces.revoked",
    ]);
    expect(keys.size).toBeGreaterThan(70);
    for (const key of keys) expectMessage(key);
  });
});
