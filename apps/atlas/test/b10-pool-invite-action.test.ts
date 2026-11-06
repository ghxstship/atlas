import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B10 (G-132, C19): the Pools page's invite form. The org's locale.language says how a standing rate and a work phone are
 * written, not the viewer's language, and neither reaches the database unread. The repositories are fakes, so each test
 * sees exactly what would be sent.
 */

const state = vi.hoisted(() => ({
  language: "en-US" as string | null,
  invited: [] as Record<string, unknown>[],
  refusal: null as string | null,
}));

const POOL = "0b8f3a52-2f5c-4f0e-9a51-5d1b1c7f0a11";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
// A viewer's language must never decide: reading it would fail the test.
vi.mock("next-intl/server", () => ({
  getLocale: async () => {
    throw new Error("the viewer's language was read");
  },
}));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({
    org: { id: "org-1", slug: "acme" },
    role: "owner",
    viewer: {
      person: { id: "person-1" },
      db: {
        from: () => ({
          select: async () => ({ data: [{ currency_code: "USD", minor_unit_exponent: 2 }] }),
        }),
      },
    },
  }),
}));
vi.mock("@xos/data/settings", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readOrgLanguage: async () => state.language,
}));
vi.mock("@xos/data/pool-invitations", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  inviteToPool: async (_db: unknown, input: Record<string, unknown>) => {
    if (state.refusal) {
      return { ok: false, error: { kind: "refusal", rule: state.refusal, message: state.refusal } };
    }
    state.invited.push(input);
    return { ok: true, data: { id: "invitation-1" } };
  },
}));
vi.mock("@xos/data/home", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  orgBaseCurrency: async () => ({ ok: true, data: "USD" }),
}));

const { invitePoolMemberAction } = await import("../app/[org]/opportunities/actions");

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  data.set("org", "acme");
  data.set("poolId", POOL);
  data.set("email", "ana@example.com");
  data.set("validFor", "30");
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

describe("inviting someone to a pool from its page", () => {
  beforeEach(() => {
    state.language = "en-US";
    state.invited = [];
    state.refusal = null;
  });

  it("reads the rate with the org's language: comma groups and a dot for decimals", async () => {
    const answer = await invitePoolMemberAction({}, form({ rate: "$1,250.50/day" }));
    expect(answer.ok).toBe(true);
    expect(state.invited[0]?.["rate"]).toEqual({
      rateType: "Day",
      rateMinor: 125050,
      currency: "USD",
    });
  });

  it("reads the same text differently for an org that writes dots as groups", async () => {
    state.language = "de-DE";
    await invitePoolMemberAction({}, form({ rate: "1.250,50 $/day" }));
    expect(state.invited[0]?.["rate"]).toMatchObject({ rateMinor: 125050 });
  });

  it("holds a rate the org's format cannot read, and keeps what was typed", async () => {
    const answer = await invitePoolMemberAction({}, form({ rate: "$12.345/day" }));
    expect(state.invited).toEqual([]);
    expect(answer.fieldErrors?.["rate"]).toBe("invalid_rate");
    expect(answer.values?.["rate"]).toBe("$12.345/day");
  });

  it("asks for a rate type rather than guessing one", async () => {
    const answer = await invitePoolMemberAction({}, form({ rate: "$250" }));
    expect(state.invited).toEqual([]);
    expect(answer.fieldErrors?.["rate"]).toBe("rate_type_required");
  });

  it("saves the work phone in E.164, reading it in the org's region", async () => {
    await invitePoolMemberAction({}, form({ workPhone: "(305) 555-0142" }));
    expect(state.invited[0]?.["workPhone"]).toBe("+13055550142");
  });

  it("holds a phone it cannot read", async () => {
    const answer = await invitePoolMemberAction({}, form({ workPhone: "12" }));
    expect(state.invited).toEqual([]);
    expect(answer.fieldErrors?.["workPhone"]).toBe("phone");
  });

  it("reports a refusal with the typed values kept", async () => {
    state.refusal = "pool_invitation_duplicate";
    const answer = await invitePoolMemberAction({}, form({}));
    expect(answer.ok).toBeFalsy();
    expect(answer.values?.["email"]).toBe("ana@example.com");
  });
});
