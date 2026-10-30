import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A one-tap email link meets its org's security settings before it acts (A127, ADR 0106), as the same action in the
 * org's Inbox does: /auth/act/{token} is outside /{org}, so the confirm button resolves the member's standing in the
 * link's org itself. A refused network, a second factor the org requires, or a session past its lifetime or idle
 * timeout sends the person on and nothing acts.
 */

const TOKEN = `xact_${"a".repeat(48)}.${"b".repeat(32)}`;

const state = vi.hoisted(() => ({
  standing: "member" as "member" | "not-member" | "restricted" | "mfa" | "idle" | "lifetime",
  audience: "Atlas" as "Atlas" | "Gateway",
  secondFactorOwed: false,
  readAs: [] as string[],
  acted: [] as { token: string; app: string; comment?: string | null }[],
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/shell/context", () => ({
  getViewer: async () => ({
    db: {},
    userId: "u1",
    email: "ana@example.com",
    emailConfirmed: true,
    person: { id: "p1" },
    secondFactorOwed: state.secondFactorOwed,
  }),
}));
vi.mock("@/lib/shell/membership", () => ({
  resolveMembership: async (
    _db: unknown,
    _person: string,
    _slug: string,
    _headers: Headers,
    onRestricted?: () => void,
    auth?: { onRequired?: (decision: "mfa" | "idle" | "lifetime") => void },
  ) => {
    if (state.standing === "member") return { org: { slug: "acme" } };
    if (state.standing === "restricted") onRestricted?.();
    if (state.standing === "mfa" || state.standing === "idle" || state.standing === "lifetime")
      auth?.onRequired?.(state.standing);
    return null;
  },
}));
vi.mock("@xos/data/notification-actions", () => ({
  isActionToken: (token: string) => /^xact_[0-9a-f]{48}\.[0-9a-f]{32}$/.test(token),
  // The database answers elsewhere for a link sent for the other app (migration 2200).
  readActionLink: async (_db: unknown, _token: string, app: string) => {
    state.readAs.push(app);
    return {
      ok: true,
      data: {
        state: state.audience === app ? "ready" : "elsewhere",
        action: "approve",
        kind: "approval.requested",
        title: "PO-1042",
        orgName: "Acme Live",
        orgSlug: "acme",
        audience: state.audience,
        expiresAt: "2026-11-06T00:00:00Z",
      },
    };
  },
  actThroughLink: async (
    _db: unknown,
    input: { token: string; app: string; comment?: string | null },
  ) => {
    state.acted.push(input);
    return { ok: true, data: "n1" };
  },
}));

const { confirmActionLink } = await import("../app/auth/act/[token]/actions");
const { actionLinkGateRedirect } = await import("../lib/auth/action-link-gate");

function press(action = "approve") {
  const form = new FormData();
  form.set("token", TOKEN);
  form.set("action", action);
  return confirmActionLink({}, form);
}

describe("a one-tap link meets its org's security settings (A127)", () => {
  beforeEach(() => {
    state.standing = "member";
    state.audience = "Atlas";
    state.secondFactorOwed = false;
    state.readAs = [];
    state.acted = [];
  });

  it("acts for a member the org admits", async () => {
    await expect(press()).resolves.toMatchObject({ done: "approve" });
    expect(state.acted).toEqual([{ token: TOKEN, app: "Atlas", comment: null }]);
    expect(state.readAs).toEqual(["Atlas"]);
  });

  it("sends a refused network to the network notice and does not act", async () => {
    state.standing = "restricted";
    await expect(press()).rejects.toThrow("redirect:/auth/network-restricted?org=acme");
    expect(state.acted).toEqual([]);
  });

  it("asks for the second factor the org's MFA policy requires, then returns to the link", async () => {
    state.standing = "mfa";
    await expect(press()).rejects.toThrow(
      `redirect:/auth/mfa?next=${encodeURIComponent(`/auth/act/${TOKEN}`)}&org=acme`,
    );
    expect(state.acted).toEqual([]);
  });

  it("asks to sign in again past the org's idle timeout or session lifetime", async () => {
    state.standing = "idle";
    await expect(press()).rejects.toThrow("redirect:/auth/session-ended?org=acme&reason=idle");
    state.standing = "lifetime";
    await expect(press()).rejects.toThrow("redirect:/auth/session-ended?org=acme&reason=lifetime");
    expect(state.acted).toEqual([]);
  });

  it("asks for a second factor the person holds but this session has not passed", async () => {
    state.secondFactorOwed = true;
    await expect(press()).rejects.toThrow("redirect:/auth/mfa?next=");
    expect(state.acted).toEqual([]);
  });

  it("refuses a member's link once the person is no longer a member", async () => {
    state.standing = "not-member";
    await expect(press()).resolves.toMatchObject({ rule: "notification_action_invalid" });
    expect(state.acted).toEqual([]);
  });

  it("does not act on an external party's or an applicant's link, which is Gateway's", async () => {
    state.standing = "not-member";
    state.audience = "Gateway";
    await expect(press("accept")).resolves.toMatchObject({ rule: "notification_action_elsewhere" });
    expect(state.acted).toEqual([]);
  });

  it("lets a member through and sends every other standing somewhere", () => {
    expect(actionLinkGateRedirect({ kind: "member" }, "acme", TOKEN)).toBeNull();
    expect(actionLinkGateRedirect({ kind: "not-member" }, "acme", TOKEN)).toBeNull();
    expect(actionLinkGateRedirect({ kind: "restricted" }, "acme", TOKEN)).toBe(
      "/auth/network-restricted?org=acme",
    );
    expect(
      actionLinkGateRedirect({ kind: "owed", decision: "signed-out" }, "acme", TOKEN),
    ).toContain("reason=signed-out");
  });
});
