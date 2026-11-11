// @vitest-environment jsdom
/**
 * Inviting an email that already has an invitation waiting revokes the earlier one (app.invite_member), so its link stops
 * working; the form said nothing (crawl 4.9). It now warns before the invite is created and says so after.
 */
import { getMessages } from "@xos/i18n";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replacesPendingInvite } from "@/lib/settings/invite-replace";

const invite = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    invite: {
      email: "ada@example.com",
      link: "https://atlas.example/auth/invite/t",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  })),
);
vi.mock("@/app/[org]/settings/actions", () => ({
  inviteMemberAction: invite,
  removeMemberAction: vi.fn(),
  renameOrganizationAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  setMemberRoleAction: vi.fn(),
}));
vi.mock("@/components/auth/security/step-up", () => ({ useStepUp: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));

const { InviteForm } = await import("@/components/settings/forms");
const messages = getMessages("en-US") as {
  shell: { settings: { members: { invite: Record<string, string> } } };
};
const copy = messages.shell.settings.members.invite;

afterEach(cleanup);

const tree = () =>
  h(NextIntlClientProvider, {
    locale: "en-US",
    messages,
    timeZone: "America/New_York",
    children: h(InviteForm, {
      org: "acme",
      roles: [{ id: "00000000-0000-4000-8000-000000000001", label: "Viewer" }],
      defaultRoleId: "00000000-0000-4000-8000-000000000001",
      pendingEmails: ["ada@example.com"],
    }),
  });

describe("re-inviting an email", () => {
  it("matches pending emails trimmed and in any case", () => {
    expect(replacesPendingInvite(" ADA@example.com ", ["ada@example.com"])).toBe(true);
    expect(replacesPendingInvite("bob@example.com", ["ada@example.com"])).toBe(false);
    expect(replacesPendingInvite("", [""])).toBe(false);
  });

  it("warns that the earlier link stops working, and says it did", async () => {
    render(tree());
    const email = screen.getByLabelText(copy["email"] ?? "Email");
    await userEvent.type(email, "bob@example.com");
    expect(screen.queryByText(copy["replaces"] ?? "")).toBeNull();
    await userEvent.clear(email);
    await userEvent.type(email, "Ada@Example.com");
    expect(screen.getByText(copy["replaces"] ?? "")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: copy["submit"] ?? "" }));
    await waitFor(() => expect(invite).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(new RegExp(copy["replaced"] ?? "x"))).toBeTruthy());
  });
});
