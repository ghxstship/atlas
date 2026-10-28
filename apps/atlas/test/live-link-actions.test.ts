import type * as LiveLinks from "@xos/data/live-links";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";

/**
 * P1 (RRR-215, ADR 0130): the live link server actions behind the saved view and display screen
 * dialogs. The database decides who may make a link and every rule (pgTAP 2780); the actions turn a
 * project key into its id, keep the expiry inside the 90 days, build the public address on the Atlas
 * origin, and report refusals by rule. A new link's address and code come back once.
 */
const state = vi.hoisted(() => ({ ctx: null as unknown }));
const TOKEN = `xshv_${"ab".repeat(32)}`;
const SCREEN = `xscr_${"cd".repeat(32)}`;
const data = vi.hoisted(() => ({
  createView: vi.fn(),
  createDisplay: vi.fn(),
  regenerate: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: () => ({ ATLAS_SITE_URL: "https://atlas.example.test" }) }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@xos/data/work", () => ({
  listProjectRefs: async () => ({
    ok: true,
    data: [
      { id: "0192f3a0-0000-7000-8000-000000000001", key: "NWL", name: "Northwind Summer Series" },
    ],
  }),
}));
vi.mock("@xos/data/live-links", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveLinks>()),
  createViewLink: data.createView,
  createDisplayLink: data.createDisplay,
  regenerateLiveLink: data.regenerate,
  revokeLiveLink: data.revoke,
}));

const actions = await import("@/lib/live-links/actions");

const VIEW = "0192f3a0-0000-7000-8000-000000000002";
const RUN = "0192f3a0-0000-7000-8000-000000000003";
const LINK = "0192f3a0-0000-7000-8000-000000000004";

const refusedWith = (rule: string) => ({
  ok: false,
  error: { kind: "refusal", rule, message: rule },
});

describe("live link actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ctx = {
      org: { id: "org-1", slug: "northwind-live", name: "Northwind Live" },
      viewer: { db: {}, person: { id: "dave" } },
    } as unknown as OrgContext;
    data.createView.mockResolvedValue({
      ok: true,
      data: { id: LINK, token: TOKEN, accessCode: "042424", expiresAt: "2026-11-27T23:59:59.000Z" },
    });
    data.createDisplay.mockResolvedValue({
      ok: true,
      data: { id: LINK, token: SCREEN, accessCode: "135790", expiresAt: "2026-11-02T04:00:00Z" },
    });
  });

  it("makes a view link on the project the key names, with its address on the Atlas origin", async () => {
    const result = await actions.createViewLinkAction("northwind-live", {
      savedViewId: VIEW,
      projectKey: "NWL",
      expiresOn: "2026-11-27",
      note: " Venue ",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        url: `https://atlas.example.test/share/view/${TOKEN}`,
        accessCode: "042424",
        expiresAt: "2026-11-27T23:59:59.000Z",
      },
    });
    expect(data.createView.mock.calls[0]?.[1]).toEqual({
      savedViewId: VIEW,
      projectId: "0192f3a0-0000-7000-8000-000000000001",
      expiresAt: "2026-11-27T23:59:59.000Z",
      note: "Venue",
    });
  });

  it("asks for a project it cannot find, and never calls the database", async () => {
    const result = await actions.createViewLinkAction("northwind-live", {
      savedViewId: VIEW,
      projectKey: "XYZ",
      expiresOn: "2026-11-27",
      note: "",
    });
    expect(result).toEqual({ ok: false, error: "projectRequired" });
    expect(data.createView).not.toHaveBeenCalled();
  });

  it("reports the database's refusal by its rule", async () => {
    data.createView.mockResolvedValue(refusedWith("live_link_view_unsupported"));
    const result = await actions.createViewLinkAction("northwind-live", {
      savedViewId: VIEW,
      projectKey: "NWL",
      expiresOn: "2026-11-27",
      note: "",
    });
    expect(result).toEqual({ ok: false, error: "live_link_view_unsupported" });
  });

  it("keeps a picked expiry inside the 90 days the database allows", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    expect(await actions.expiryFor("2026-11-27", now)).toBe("2026-11-27T23:59:59.000Z");
    const last = Date.parse(await actions.expiryFor("2027-01-26", now));
    expect(last).toBeLessThan(now.getTime() + 90 * 86_400_000);
  });

  it("leaves a display link's expiry to the database's default when none is picked", async () => {
    const result = await actions.createDisplayLinkAction("northwind-live", {
      runOfShowId: RUN,
      expiresOn: "",
      defaultMode: "Presenter Timer",
      note: "",
    });
    expect(result.ok && result.data.url).toBe(`https://atlas.example.test/share/screen/${SCREEN}`);
    expect(data.createDisplay.mock.calls[0]?.[1]).toEqual({
      runOfShowId: RUN,
      expiresAt: null,
      defaultMode: "Presenter Timer",
      note: null,
    });
  });

  it("refuses an unknown display mode before the database", async () => {
    const result = await actions.createDisplayLinkAction("northwind-live", {
      runOfShowId: RUN,
      expiresOn: "",
      defaultMode: "Karaoke",
      note: "",
    });
    expect(result.ok).toBe(false);
    expect(data.createDisplay).not.toHaveBeenCalled();
  });

  it("regenerates a link with a new address for its kind, and revokes", async () => {
    data.regenerate.mockResolvedValue({
      ok: true,
      data: { token: SCREEN, accessCode: "246802", expiresAt: "2026-11-02T04:00:00Z" },
    });
    const fresh = await actions.regenerateLiveLinkAction("northwind-live", LINK, "Display");
    expect(fresh.ok && fresh.data.url).toBe(`https://atlas.example.test/share/screen/${SCREEN}`);
    data.revoke.mockResolvedValue({ ok: true, data: "2026-10-28T10:00:00Z" });
    expect(await actions.revokeLiveLinkAction("northwind-live", LINK)).toEqual({
      ok: true,
      data: "2026-10-28T10:00:00Z",
    });
    expect(await actions.revokeLiveLinkAction("northwind-live", "not-a-uuid")).toEqual({
      ok: false,
      error: "notFound",
    });
  });

  it("answers notFound outside an org the person belongs to", async () => {
    state.ctx = null;
    expect(await actions.revokeLiveLinkAction("elsewhere", LINK)).toEqual({
      ok: false,
      error: "notFound",
    });
    expect(data.revoke).not.toHaveBeenCalled();
  });
});
