import { describe, expect, it, vi } from "vitest";
import type { ModuleCapability, OperationsProject } from "@xos/data/credentials";

vi.mock("@/lib/shell/require-node", () => ({ requireNode: vi.fn() }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: vi.fn() }));
vi.mock("@/lib/shell/translate", () => ({ getTranslate: vi.fn() }));
vi.mock("@/lib/shell/sitemap", () => ({ nodeHref: vi.fn(), sitemap: {} }));

const { canOnProject, projectsWith } = await import("../lib/operations/context");
type Page = Parameters<typeof projectsWith>[0];

const project = (id: string, key: string) =>
  ({ id, key, name: key }) as unknown as OperationsProject;
const NWS = project("p1", "NWS");
const CAFX = project("p2", "CAFX");

/** An org-level module page: no project chosen, `caps` from the org alone. */
const orgPage = (
  caps: readonly ModuleCapability[],
  held: Partial<Record<ModuleCapability, readonly string[]>>,
): Page =>
  ({
    project: null,
    projects: [NWS, CAFX],
    caps: new Set(caps),
    capabilityProjects: new Map(Object.entries(held).map(([c, ids]) => [c, new Set(ids)])),
  }) as unknown as Page;

describe("org-level Safety pages offer a control held on one project (crawl 4.9)", () => {
  it("lists the projects that grant an assigned capability the org context does not hold", () => {
    const field = orgPage([], { "safety.incident.write": ["p1"] });
    expect(projectsWith(field, "safety.incident.write")).toEqual([NWS]);
    expect(projectsWith(field, "safety.incident.dispatch")).toEqual([]);
    expect(canOnProject(field, "safety.incident.write", "p1")).toBe(true);
    expect(canOnProject(field, "safety.incident.write", "p2")).toBe(false);
  });

  it("answers for the project in scope alone when one is chosen", () => {
    const page = {
      ...orgPage(["safety.incident.dispatch"], {}),
      project: CAFX,
      capabilityProjects: new Map(),
    } as unknown as Page;
    expect(projectsWith(page, "safety.incident.dispatch")).toEqual([CAFX]);
    expect(canOnProject(page, "safety.incident.dispatch", "p2")).toBe(true);
    expect(canOnProject(page, "safety.incident.dispatch", "p1")).toBe(false);
    expect(projectsWith(page, "safety.incident.write")).toEqual([]);
  });

  it("keeps an org-wide holder able to act on any project", () => {
    const manager = orgPage(["safety.incident.dispatch"], {
      "safety.incident.dispatch": ["p1", "p2"],
    });
    expect(projectsWith(manager, "safety.incident.dispatch")).toEqual([NWS, CAFX]);
    expect(canOnProject(manager, "safety.incident.dispatch", "p2")).toBe(true);
  });
});
