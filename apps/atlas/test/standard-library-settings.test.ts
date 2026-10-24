import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";

/**
 * WP18 (finding A65-027, migration 1612). Settings, Canon Extensions shows how much of each Standard Library table
 * the org holds and offers "Adopt Standard Library" only to people who manage canon extensions; the action runs as
 * the viewer and reports how many rows it copied. Safety, Emergency codes saves an edited code only from valid input.
 * The database checks every capability again; these tests cover what Atlas shows and sends.
 */
const state = vi.hoisted(() => ({ ctx: null as unknown, counts: [] as unknown[] }));
const data = vi.hoisted(() => ({
  status: vi.fn(async () => ({ ok: true, data: state.counts })),
  adopt: vi.fn(async () => ({ ok: true, data: { copied: {}, total: 14 } })),
  updateCode: vi.fn(async () => ({ ok: true, data: null })),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => Object.assign((key: string) => key, { has: () => false }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@xos/data/standard-library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xos/data/standard-library")>()),
  getStandardLibraryStatus: data.status,
  adoptStandardLibrary: data.adopt,
}));
vi.mock("@xos/data/incidents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xos/data/incidents")>()),
  updateEmergencyCode: data.updateCode,
}));

const { contributions } = await import("@/components/settings/contributions/wp18");
const { adoptStandardLibraryAction } =
  await import("@/components/settings/contributions/wp18-actions");
const { updateEmergencyCodeAction } = await import("@/lib/incidents/actions");
const { ActionForm } = await import("@/components/operations/action-form");

const Panel = contributions[0]!.Panel;
const db = { rpc: vi.fn() };

function contextWith(capabilities: readonly string[]): OrgContext {
  return {
    org: { id: "org-1", slug: "northwind-live", name: "Northwind Live" },
    capabilities: new Set(capabilities),
    viewer: { db, person: { id: "person-1" } },
  } as unknown as OrgContext;
}

function counts(adopted: number) {
  return [
    { library: "emergency_codes", standardCount: 14, adoptedCount: adopted },
    { library: "sops", standardCount: 34, adoptedCount: 34 },
  ];
}

/** Every element in a rendered tree, depth first. */
function elements(node: unknown): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  return [element, ...elements(element.props["children"])];
}

const texts = (tree: unknown) =>
  elements(tree).flatMap((e) =>
    typeof e.props["children"] === "string" ? [e.props["children"]] : [],
  );

function form(values: Record<string, string>): FormData {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

describe("the Standard Library on Settings, Canon Extensions", () => {
  beforeEach(() => {
    state.counts = counts(0);
    data.status.mockClear();
    data.adopt.mockClear();
  });

  it("shows nothing without org.settings.read", async () => {
    expect(await Panel({ ctx: contextWith([]) } as never)).toBeNull();
    expect(data.status).not.toHaveBeenCalled();
  });

  it("offers the adopt action to people who manage canon extensions", async () => {
    const tree = await Panel({
      ctx: contextWith(["org.settings.read", "canon.extension.write"]),
    } as never);
    expect(data.status).toHaveBeenCalledWith(db, "org-1");
    const action = elements(tree).find((e) => e.type === ActionForm);
    expect(action?.props["action"]).toBe(adoptStandardLibraryAction);
    expect(action?.props["hidden"]).toEqual({ org: "northwind-live" });
    expect(texts(tree)).toContain("skipped");
  });

  it("tells everyone else who may adopt, and offers no action", async () => {
    const tree = await Panel({ ctx: contextWith(["org.settings.read"]) } as never);
    expect(elements(tree).some((e) => e.type === ActionForm)).toBe(false);
    expect(texts(tree)).toContain("manageOnly");
  });

  it("says the org holds the whole library once it does", async () => {
    state.counts = counts(14);
    const tree = await Panel({
      ctx: contextWith(["org.settings.read", "canon.extension.write"]),
    } as never);
    expect(elements(tree).some((e) => e.type === ActionForm)).toBe(false);
    expect(texts(tree)).toContain("complete");
  });

  it("adopts as the viewer and reports the rows copied", async () => {
    state.ctx = contextWith(["org.settings.read", "canon.extension.write"]);
    expect(await adoptStandardLibraryAction({}, form({ org: "northwind-live" }))).toEqual({
      ok: true,
      result: { count: "14" },
    });
    expect(data.adopt).toHaveBeenCalledWith(db, "org-1");
  });

  it("reports the database's refusal", async () => {
    state.ctx = contextWith(["org.settings.read"]);
    data.adopt.mockResolvedValueOnce({ ok: false, error: { kind: "forbidden" } } as never);
    expect(await adoptStandardLibraryAction({}, form({ org: "northwind-live" }))).toHaveProperty(
      "error",
    );
  });
});

describe("editing the org's emergency codes", () => {
  beforeEach(() => {
    state.ctx = contextWith(["safety.emergency_code.write"]);
    data.updateCode.mockClear();
  });

  const code = {
    org: "northwind-live",
    id: "0190f1a2-0000-7000-8000-000000000001",
    label: " Fire Alarm ",
    emergency: "Fire or smoke in the venue.",
    sortOrder: "20",
  };

  it("saves the label, the emergency and the place in the list", async () => {
    expect(await updateEmergencyCodeAction({}, form(code))).toEqual({ ok: true });
    expect(data.updateCode).toHaveBeenCalledWith(db, code.id, {
      id: code.id,
      label: "Fire Alarm",
      emergency: "Fire or smoke in the venue.",
      sortOrder: 20,
    });
  });

  it("saves nothing from a blank label or a position below one", async () => {
    expect(await updateEmergencyCodeAction({}, form({ ...code, label: " " }))).toEqual({
      error: "emergencyCodeInput",
    });
    expect(await updateEmergencyCodeAction({}, form({ ...code, sortOrder: "0" }))).toEqual({
      error: "emergencyCodeInput",
    });
    expect(data.updateCode).not.toHaveBeenCalled();
  });
});
