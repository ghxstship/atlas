import type * as PlanLimits from "@xos/data/plan-limits";
import type { OrgBannerStatus } from "@xos/data/org-lifecycle";
import { getMessages, type Locale } from "@xos/i18n";
import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";

/**
 * A107 (S16-07, ADR 0081). The banners explain what a plan limit made read-only before anyone meets the database's
 * plan_limit_read_only refusal: the Owner gets a link to the choice in Settings, Billing and Plan, everyone else learns
 * what an Owner can do. The Owner's choice action sends the chosen ids and reports the outcome in the locale's copy.
 * @xos/data is replaced by the answers each read gives; the copy is the real catalog, in en-US and es-US.
 */
const state = vi.hoisted(() => ({ locale: "en-US", ctx: null as unknown }));
const data = vi.hoisted(() => ({
  usage: vi.fn(),
  project: vi.fn(),
  choose: vi.fn(),
}));

vi.mock("next-intl/server", async () => {
  const { getMessages: messages } = await import("@xos/i18n");
  const { createTranslator: translator } = await import("next-intl");
  return {
    getLocale: async () => state.locale,
    getTranslations: async (namespace: string) =>
      translator({
        locale: state.locale as Locale,
        messages: messages(state.locale as Locale),
        namespace: namespace as never,
      }),
  };
});
vi.mock("@/lib/shell/translate", () => ({
  getTranslate: async () => (key: string) =>
    key.replace(/^shell\.plans\.(\w+)\.name$/, (_, code: string) => code.toUpperCase()),
}));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@/lib/observability", () => ({ observability: { logger: { error: vi.fn() } } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@xos/data/plan-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof PlanLimits>()),
  getPlanLimitUsage: data.usage,
  getProjectOverLimit: data.project,
  choosePlanLimitKeeps: data.choose,
}));

const { OverLimitBanners, ProjectOverLimitBanner, LimitBanners } =
  await import("@/components/plan-limits/banners");
const { choosePlanLimitKeepsAction } =
  await import("@/components/settings/contributions/a107-actions");

const ok = <T>(value: T) => ({ ok: true as const, data: value });

function contextWith(capabilities: readonly string[]): OrgContext {
  return {
    org: { id: "org-1", slug: "lantern-rigging", name: "Lantern Rigging" },
    capabilities: new Set(capabilities),
    viewer: { db: {}, person: { id: "person-1" } },
  } as unknown as OrgContext;
}

const owner = contextWith(["org.billing.read", "org.billing.manage"]);
const member = contextWith([]);

const usage: PlanLimits.PlanLimitUsage[] = [
  { limit: "active_projects", planCode: "access", limitValue: 1, inUse: 3, readOnly: 2 },
  { limit: "seats", planCode: "access", limitValue: 1, inUse: 3, readOnly: 2 },
  { limit: "field_members", planCode: "access", limitValue: 10, inUse: 2, readOnly: 0 },
];

function status(
  overLimit: OrgBannerStatus["overLimit"],
  ownSeat: OrgBannerStatus["ownSeatReadOnly"] = null,
) {
  return { overLimit, ownSeatReadOnly: ownSeat } as OrgBannerStatus;
}

type Element = { type: unknown; props: Record<string, unknown> };

/** Every element in a tree, depth first; function components other than Link are called, as React would. */
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  if (typeof element.type === "function" && element.type.name === "Fix") {
    return elements((element.type as (p: unknown) => unknown)(element.props));
  }
  return [element, ...elements(element.props["children"])];
}

/** The text of a tree: strings and numbers in document order. */
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node === null || typeof node !== "object" || !("props" in node)) return "";
  const element = node as Element;
  if (typeof element.type === "function" && element.type.name === "Fix") {
    return text((element.type as (p: unknown) => unknown)(element.props));
  }
  return text(element.props["children"]);
}

const byTestId = (tree: unknown, id: string) =>
  elements(tree).find((e) => e.props["data-testid"] === id) ?? null;

const hrefs = (tree: unknown) =>
  elements(tree).flatMap((e) => (typeof e.props["href"] === "string" ? [e.props["href"]] : []));

function form(values: Record<string, string | string[]>): FormData {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const v of Array.isArray(value) ? value : [value]) result.append(key, v);
  }
  return result;
}

beforeEach(() => {
  state.locale = "en-US";
  state.ctx = owner;
  for (const fn of Object.values(data)) fn.mockReset();
  data.usage.mockResolvedValue(ok(usage));
});

describe("the banners above every page", () => {
  it("show nothing when nothing is read-only", async () => {
    expect(await OverLimitBanners({ ctx: owner, status: status(null) })).toEqual([]);
    expect(data.usage).not.toHaveBeenCalled();
  });

  it("tell the Owner what is read-only and link to the choice", async () => {
    const banners = await OverLimitBanners({
      ctx: owner,
      status: status({ planCode: "access", projects: 2, seats: 2, fieldSeats: 0 }),
    });
    const summary = byTestId(banners, "over-limit-banner");
    expect(text(summary)).toBe(
      "The organization is over the ACCESS plan's limits, so 2 projects and 2 seats are read-only. Nothing is deleted. Choose what stays writable, or upgrade",
    );
    expect(hrefs(banners)).toEqual(["/lantern-rigging/settings/billing-and-plan#plan-limits"]);
    expect(byTestId(banners, "own-seat-read-only-banner")).toBeNull();
  });

  it("tell a member whose seat is read-only, and what an Owner can do, without the summary", async () => {
    const banners = await OverLimitBanners({
      ctx: member,
      status: status({ planCode: "access", projects: 2, seats: 2, fieldSeats: 0 }, "seats"),
    });
    expect(byTestId(banners, "over-limit-banner")).toBeNull();
    expect(text(byTestId(banners, "own-seat-read-only-banner"))).toBe(
      "Your seat is read-only: the ACCESS plan includes 1 seat, and more members hold one. You can still read everything. An Owner can choose what stays writable, archive a project or end a membership, or upgrade the plan.",
    );
    expect(hrefs(banners)).toEqual([]);
  });

  it("speak es-US", async () => {
    state.locale = "es-US";
    const banners = await OverLimitBanners({
      ctx: member,
      status: status(null, "field_members"),
    });
    const own = text(byTestId(banners, "own-seat-read-only-banner"));
    expect(own).toContain("ACCESS");
    expect(own).toContain("10");
    expect(own).not.toMatch(/Your field seat/);
  });
});

describe("the banner on a read-only project", () => {
  it("shows nothing on a writable project", async () => {
    data.project.mockResolvedValue(ok(null));
    expect(await ProjectOverLimitBanner({ ctx: owner, projectId: "p-1" })).toBeNull();
    expect(data.project).toHaveBeenCalledWith(owner.viewer.db, "p-1");
  });

  it("names the plan and the limit on a read-only one", async () => {
    data.project.mockResolvedValue(ok({ planCode: "access", since: "2026-10-27T12:00:00Z" }));
    const banner = await ProjectOverLimitBanner({ ctx: member, projectId: "p-2" });
    expect(text(byTestId(banner, "project-read-only-banner"))).toBe(
      "This project is read-only: the ACCESS plan allows 1 active project, and the organization has more. You can still read everything in it, and nothing is deleted. An Owner can choose what stays writable, archive a project or end a membership, or upgrade the plan.",
    );
  });
});

describe("the banners on Projects and Members", () => {
  it("count only the limits the page lists that have read-only objects", async () => {
    const banners = await LimitBanners({ ctx: owner, limits: ["seats", "field_members"] });
    expect(byTestId(banners, "limit-banner-seats")).not.toBeNull();
    expect(byTestId(banners, "limit-banner-field_members")).toBeNull();
    expect(byTestId(banners, "limit-banner-active_projects")).toBeNull();
    expect(text(byTestId(banners, "limit-banner-seats"))).toContain(
      "2 members' seats are read-only: the ACCESS plan includes 1 seat.",
    );
  });

  it("show nothing when the usage cannot be read", async () => {
    data.usage.mockResolvedValue({ ok: false, error: { kind: "unexpected", message: "down" } });
    expect(await LimitBanners({ ctx: owner, limits: ["active_projects"] })).toBeNull();
  });
});

describe("the Owner's choice", () => {
  const keep = "0199a2b4-0000-7000-8000-000000000001";

  it("sends the chosen ids for the limit and says how many stay read-only", async () => {
    data.choose.mockResolvedValue(ok(2));
    const result = await choosePlanLimitKeepsAction(
      {},
      form({ org: "lantern-rigging", limit: "active_projects", keep: [keep] }),
    );
    expect(data.choose).toHaveBeenCalledWith(owner.viewer.db, "org-1", "active_projects", [keep]);
    expect(result.ok).toBe(true);
    const t = createTranslator({
      locale: "en-US",
      messages: getMessages("en-US"),
      namespace: "planLimits",
    });
    expect(result.message).toBe(t("panel.saved", { count: 2 }));
  });

  it("explains a refused choice", async () => {
    data.choose.mockResolvedValue({
      ok: false,
      error: { kind: "refusal", rule: "plan_limit_choice_too_many", message: "too many" },
    });
    const result = await choosePlanLimitKeepsAction(
      {},
      form({ org: "lantern-rigging", limit: "seats", keep: [keep] }),
    );
    expect(result.ok).toBeUndefined();
    const t = createTranslator({
      locale: "en-US",
      messages: getMessages("en-US"),
      namespace: "planLimits",
    });
    expect(result.message).toBe(t("errors.plan_limit_choice_too_many"));
  });

  it("refuses a limit that makes nothing read-only before calling the database", async () => {
    const result = await choosePlanLimitKeepsAction(
      {},
      form({ org: "lantern-rigging", limit: "aurora_requests_per_month", keep: [keep] }),
    );
    expect(data.choose).not.toHaveBeenCalled();
    const t = createTranslator({
      locale: "en-US",
      messages: getMessages("en-US"),
      namespace: "planLimits",
    });
    expect(result.message).toBe(t("errors.unexpected"));
  });

  it("is a 404 when the org is gone", async () => {
    state.ctx = null;
    await expect(
      choosePlanLimitKeepsAction({}, form({ org: "gone", limit: "seats", keep: [] })),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
