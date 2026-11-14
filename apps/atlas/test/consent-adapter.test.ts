import type { XosClient } from "@xos/data";
import { CONSENT_BANNER_VERSION } from "@xos/data/consent";
import { decideConsent } from "@xos/ui/consent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { atlasConsentAdapter, CONSENT_CATEGORIES } from "@/lib/privacy/consent-adapter";

/**
 * Atlas's side of the shared cookie banner (issue 107): the database-backed consent adapter and the
 * server action the banner's forms post to. The consent cookie keeps the format the proxy, the
 * analytics seam and the journeys read: `1.<visitor>.<preferences><performance>.<gpc>`.
 */

const VISITOR = "0123456789abcdef0123456789abcdef";

interface SetCookie {
  readonly value: string;
  readonly options: Record<string, unknown>;
}

function jar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const sets = new Map<string, SetCookie>();
  return {
    sets,
    get: (name: string) => (values.has(name) ? { value: values.get(name) as string } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      values.set(name, value);
      sets.set(name, { value, options });
    },
  };
}

function database(outcome: { data: unknown; error: unknown } = { data: true, error: null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    schema: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return outcome;
      },
    }),
  } as unknown as XosClient;
  return { db, calls };
}

const decide = (choice: "all" | "none" | "save", selected: string[] = [], gpc = false) =>
  decideConsent({
    choice,
    categories: CONSENT_CATEGORIES,
    selected,
    gpc,
    policyVersion: CONSENT_BANNER_VERSION,
  });

describe("atlasConsentAdapter", () => {
  it("reads null before a choice and the categories after one", async () => {
    const { db } = database();
    expect(await atlasConsentAdapter({ db, cookies: jar(), secure: true }).read()).toBeNull();
    const cookies = jar({ "xos-consent": `1.${VISITOR}.10.0` });
    expect(await atlasConsentAdapter({ db, cookies, secure: true }).read()).toEqual({
      categories: { preferences: true, performance: false },
      gpc: false,
    });
  });

  it("writes the decision to the consent log with the policy version and the signal flag", async () => {
    const { db, calls } = database();
    const cookies = jar({ "xos-consent": `1.${VISITOR}.00.0` });
    const adapter = atlasConsentAdapter({ db, cookies, secure: true });
    await adapter.write({
      ...decide("save", ["preferences"]),
      policyVersion: "cookie-policy 9.9.9",
    });
    expect(calls).toEqual([
      {
        fn: "record_cookie_consent",
        args: {
          p_visitor_id: VISITOR,
          p_org_slug: null,
          p_functional: true,
          p_analytics: false,
          p_marketing: false,
          p_banner_version: "cookie-policy 9.9.9",
          p_global_privacy_control: false,
        },
      },
    ]);
    expect(cookies.sets.get("xos-consent")).toEqual({
      value: `1.${VISITOR}.10.0`,
      options: { path: "/", sameSite: "lax", httpOnly: true, secure: true, maxAge: 31_536_000 },
    });
    expect(await adapter.read()).toEqual({
      categories: { preferences: true, performance: false },
      gpc: false,
    });
  });

  it("gives a new visitor an id and keeps it on the next decision", async () => {
    const { db, calls } = database();
    const cookies = jar();
    const adapter = atlasConsentAdapter({ db, cookies, secure: false });
    await adapter.write(decide("all"));
    const first = cookies.sets.get("xos-consent")?.value ?? "";
    expect(first).toMatch(/^1\.[0-9a-f]{32}\.11\.0$/);
    await adapter.write(decide("none"));
    expect(cookies.sets.get("xos-consent")?.value).toBe(first.replace(".11.0", ".00.0"));
    expect(calls[0]?.args["p_visitor_id"]).toBe(calls[1]?.args["p_visitor_id"]);
    expect(cookies.sets.get("xos-consent")?.options["secure"]).toBe(false);
  });

  it("turns the Preferences cookies into visit-only cookies when Preferences are refused", async () => {
    const { db } = database();
    const cookies = jar({ "xos-theme": "light", "xos-locale": "es-US", "xos-auth": "session" });
    await atlasConsentAdapter({ db, cookies, secure: true }).write(decide("none"));
    for (const name of ["xos-theme", "xos-locale"]) {
      expect(cookies.sets.get(name)?.options).toEqual({
        path: "/",
        sameSite: "lax",
        httpOnly: true,
        secure: true,
      });
    }
    expect(cookies.sets.has("xos-auth")).toBe(false);
    expect(cookies.sets.has("xos-workspace")).toBe(false);

    const kept = jar({ "xos-theme": "light" });
    await atlasConsentAdapter({ db, cookies: kept, secure: true }).write(decide("all"));
    expect(kept.sets.has("xos-theme")).toBe(false);
  });

  it("records a Global Privacy Control decision as a refusal of every category", async () => {
    const { db, calls } = database();
    const cookies = jar();
    await atlasConsentAdapter({ db, cookies, secure: true }).write({
      ...decide("none", [], true),
      categories: { preferences: true, performance: true },
    });
    expect(calls[0]?.args).toMatchObject({
      p_functional: false,
      p_analytics: false,
      p_global_privacy_control: true,
    });
    expect(cookies.sets.get("xos-consent")?.value).toMatch(/\.00\.1$/);
  });

  it("still sets the cookie when the consent log refuses the write, and says so", async () => {
    const { db } = database({ data: null, error: { message: "rate limited", code: "P0001" } });
    const cookies = jar();
    const onUnrecorded = vi.fn();
    await atlasConsentAdapter({ db, cookies, secure: true, onUnrecorded }).write(decide("all"));
    expect(onUnrecorded).toHaveBeenCalledTimes(1);
    expect(cookies.sets.get("xos-consent")?.value).toMatch(/\.11\.0$/);
  });
});

const request = vi.hoisted(() => ({
  cookies: undefined as unknown,
  headers: new Headers(),
  db: undefined as unknown,
  revalidated: [] as unknown[][],
  errors: [] as unknown[][],
}));

vi.mock("next/headers", () => ({
  cookies: async () => request.cookies,
  headers: async () => request.headers,
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => request.revalidated.push(args),
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => request.db }));
vi.mock("@/lib/env", () => ({ env: () => ({ ATLAS_SITE_URL: "https://atlas.example" }) }));
vi.mock("@/lib/observability", () => ({
  observability: { logger: { error: (...args: unknown[]) => request.errors.push(args) } },
}));

describe("saveCookieChoice", () => {
  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  }

  async function save(
    fields: Record<string, string>,
    options: { headers?: Record<string, string>; cookies?: Record<string, string> } = {},
  ) {
    const cookies = jar(options.cookies);
    const { db, calls } = database();
    request.cookies = cookies;
    request.headers = new Headers(options.headers);
    request.db = db;
    const { saveCookieChoice } = await import("@/lib/privacy/actions");
    await saveCookieChoice(form(fields));
    return { cookie: cookies.sets.get("xos-consent")?.value ?? "", args: calls[0]?.args ?? {} };
  }

  beforeEach(() => {
    request.revalidated.length = 0;
    request.errors.length = 0;
  });

  it("records Reject all, Accept all and saved categories in the cookie format the journeys read", async () => {
    expect((await save({ choice: "none" })).cookie).toMatch(/^1\.[0-9a-f]{32}\.00\.0$/);
    expect((await save({ choice: "all" })).cookie).toMatch(/^1\.[0-9a-f]{32}\.11\.0$/);
    const saved = await save(
      { choice: "save", preferences: "on" },
      { cookies: { "xos-consent": `1.${VISITOR}.00.0` } },
    );
    expect(saved.cookie).toBe(`1.${VISITOR}.10.0`);
    expect(saved.args).toMatchObject({
      p_visitor_id: VISITOR,
      p_functional: true,
      p_analytics: false,
      p_banner_version: CONSENT_BANNER_VERSION,
      p_global_privacy_control: false,
    });
    expect(request.revalidated).toEqual([
      ["/", "layout"],
      ["/", "layout"],
      ["/", "layout"],
    ]);
    expect(request.errors).toEqual([]);
  });

  it("ignores ticked categories on Reject all and treats an unknown choice as a refusal", async () => {
    expect((await save({ choice: "none", preferences: "on" })).cookie).toMatch(/\.00\.0$/);
    expect((await save({ choice: "everything", performance: "on" })).cookie).toMatch(/\.00\.0$/);
    expect((await save({})).cookie).toMatch(/\.00\.0$/);
  });

  it("refuses every category for a request that carries Sec-GPC: 1, whatever was ticked", async () => {
    const saved = await save(
      { choice: "all", preferences: "on", performance: "on" },
      { headers: { "Sec-GPC": "1" } },
    );
    expect(saved.cookie).toMatch(/\.00\.1$/);
    expect(saved.args).toMatchObject({
      p_functional: false,
      p_analytics: false,
      p_global_privacy_control: true,
    });
  });

  it("does the same when only the browser reported the signal and the banner posted gpc=1", async () => {
    const saved = await save({ choice: "none", gpc: "1" });
    expect(saved.cookie).toMatch(/\.00\.1$/);
    expect(saved.args).toMatchObject({ p_global_privacy_control: true });
    expect((await save({ choice: "all", gpc: "0" })).cookie).toMatch(/\.11\.0$/);
  });
});
