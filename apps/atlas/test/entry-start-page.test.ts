import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * shell.start_page takes organization, workspace and personal values (Section 4.5.6). The entry route sends a
 * signed-in person to the start page as it applies in the workspace their filter chose, so a workspace's own
 * start page beats the org's (A65-001).
 */
const jar = vi.hoisted(() => ({ workspace: undefined as string | undefined }));
const resolved = vi.hoisted(() => ({ calls: [] as { orgId: string; workspaceId?: string }[] }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === "xos-last-org") return { value: "northwind-live" };
      if (name === "xos-workspace" && jar.workspace !== undefined) return { value: jar.workspace };
      return undefined;
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/shell/context", () => ({
  getViewer: async () => ({ db: {}, userId: "u1", person: { id: "p1" } }),
  getMyOrganizations: async () => [{ id: "org-1", slug: "northwind-live", name: "Northwind Live" }],
}));
vi.mock("@xos/data", () => ({
  listWorkspaces: async () => ({
    ok: true,
    data: [{ id: "ws-festival", slug: "festival-ops", name: "Festival Ops" }],
  }),
}));
vi.mock("@xos/data/settings", () => ({
  // The org's start page is Home; the Festival Ops workspace starts on Projects.
  resolveSettings: async (_db: unknown, input: { orgId: string; workspaceId?: string }) => {
    resolved.calls.push(input);
    const value = input.workspaceId === "ws-festival" ? "projects" : "home";
    const source = input.workspaceId === "ws-festival" ? "Workspace" : "Organization";
    return {
      ok: true,
      data: new Map([
        ["shell.start_page", { key: "shell.start_page", value, source, locked: false }],
      ]),
    };
  },
}));

const { default: EntryPage } = await import("../app/page");

async function landing(query: Record<string, string> = {}): Promise<string> {
  try {
    await EntryPage({ searchParams: Promise.resolve(query) } as Parameters<typeof EntryPage>[0]);
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error("the entry page did not redirect");
}

describe("entry start page (shell.start_page)", () => {
  beforeEach(() => {
    jar.workspace = undefined;
    resolved.calls = [];
  });

  it("opens the workspace's start page when the filter chose that workspace", async () => {
    jar.workspace = "festival-ops";
    expect(await landing()).toBe("redirect:/northwind-live/projects");
    expect(resolved.calls).toEqual([{ orgId: "org-1", workspaceId: "ws-festival" }]);
  });

  it("opens the org's start page without a workspace, or for one the org does not have", async () => {
    expect(await landing()).toBe("redirect:/northwind-live/home");
    jar.workspace = "harbor-lights";
    expect(await landing()).toBe("redirect:/northwind-live/home");
  });

  it("opens an installed app shortcut's page before the start page, and ignores any other", async () => {
    jar.workspace = "festival-ops";
    expect(await landing({ open: "inbox" })).toBe("redirect:/northwind-live/inbox");
    expect(resolved.calls).toEqual([]);
    expect(await landing({ open: "settings" })).toBe("redirect:/northwind-live/projects");
  });
});
