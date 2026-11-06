import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B10 (S4.4-45): on an org's custom domain, a crew access link or a registration page of another org does not exist. On the
 * platform Gateway and on the org's own domain, both open.
 */

const state = vi.hoisted(() => ({
  brand: { kind: "platform" } as { kind: string; org?: { orgId: string } },
}));

const ORG = "0b8f3a52-2f5c-4f0e-9a51-5d1b1c7f0a11";
const OTHER = "6f1c2d4e-8a9b-4c3d-9e2f-1a2b3c4d5e6f";
const TOKEN = `xcrw_${"a".repeat(64)}`;

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "123456" }) }),
}));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en-US",
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@xos/ia", () => ({ PARAM_TYPES: { slug: /./, token: /./ } }));
vi.mock("@xos/ui", () => ({ Button: () => null, Tag: () => null }));
vi.mock("@xos/data/settings", () => ({ resolveSettings: async () => ({ ok: false }) }));
vi.mock("@xos/data/gateway", () => ({
  brandForSlug: async () => ({ ok: true, data: null }),
  openCrewShifts: async () => ({
    ok: true,
    data: {
      refused: false,
      orgId: ORG,
      orgSlug: "demo",
      orgName: "Demo",
      projectName: "Show",
      personName: "Sam",
      shifts: [],
    },
  }),
  getPublicRegistrationPage: async () => ({
    ok: true,
    data: {
      refused: false,
      orgId: ORG,
      orgName: "Demo",
      title: "Crew",
      intro: null,
      minimumAge: 18,
    },
  }),
  myRegistrations: async () => ({ ok: true, data: [] }),
}));
vi.mock("@/components/actions/action-button", () => ({ ActionButton: () => null }));
vi.mock("@/components/tokens/registration-form", () => ({ RegistrationForm: () => null }));
vi.mock("@/components/tokens/crew-shifts", () => ({
  CrewCodeForm: () => null,
  CrewShiftList: () => null,
}));
vi.mock("@/components/ui", () => ({ BrandMark: () => null, ButtonLink: () => null }));
vi.mock("@/lib/actions/registration", () => ({ withdrawRegistrationAction: async () => null }));
vi.mock("@/lib/actions/crew-shifts", () => ({
  CODE_COOKIE: "crew-code",
  forgetCrewCodeAction: async () => null,
}));
vi.mock("@/lib/shell/translate", () => ({
  enumLabelKey: (_: string, value: string) => value,
  getTranslate: async () => (key: string) => key,
}));
vi.mock("@/lib/shell/context", () => ({
  getGatewayContext: async () => null,
  getRequestFacts: async () => ({ brand: state.brand }),
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));

const { default: CrewShiftsPage } = await import("../app/(public)/shifts/[token]/page");
const { default: RegistrationPage } =
  await import("../app/(public)/join/[orgSlug]/[pageSlug]/page");

const openShifts = () => CrewShiftsPage({ params: Promise.resolve({ token: TOKEN }) } as never);
const openPage = () =>
  RegistrationPage({ params: Promise.resolve({ orgSlug: "demo", pageSlug: "crew" }) } as never);

describe("the new routes on a custom domain", () => {
  beforeEach(() => {
    state.brand = { kind: "platform" };
  });

  it("open on the platform Gateway", async () => {
    await expect(openShifts()).resolves.toBeTruthy();
    await expect(openPage()).resolves.toBeTruthy();
  });

  it("open on the org's own domain", async () => {
    state.brand = { kind: "org", org: { orgId: ORG } };
    await expect(openShifts()).resolves.toBeTruthy();
    await expect(openPage()).resolves.toBeTruthy();
  });

  it("do not exist on another org's domain", async () => {
    state.brand = { kind: "org", org: { orgId: OTHER } };
    await expect(openShifts()).rejects.toThrow("notFound");
    await expect(openPage()).rejects.toThrow("notFound");
  });
});
