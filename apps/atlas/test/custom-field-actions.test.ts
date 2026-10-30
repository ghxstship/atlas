import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Saving a row's custom fields (A117, ADR 0076): row level security drops the writes of a member below the writer
 * band (private.custom_writer_orgs, 0540) without an error, so the action refuses them itself instead of answering
 * with a success that wrote nothing. A create action holds every FormData post to required fields, whatever the
 * post carries.
 */

const state = vi.hoisted(() => ({
  role: "viewer" as string | null,
  saves: 0,
  checked: [] as { inputs: unknown; dryRun: boolean | undefined }[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({ org: { id: "org-1", slug: "acme" }, role: state.role }),
}));
vi.mock("@/lib/custom-fields/server", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  saveCustomFields: async (
    _ctx: unknown,
    input: { inputs: unknown; dryRun?: boolean; targetId: string },
  ) => {
    if (input.dryRun) {
      state.checked.push({ inputs: input.inputs, dryRun: input.dryRun });
      return { ok: false, problems: { tier: "required" } };
    }
    state.saves += 1;
    return { ok: true };
  },
}));

const { saveCustomFieldsAction } = await import("@/lib/custom-fields/actions");
const { customFieldsOf } = await import("@/lib/custom-fields/form");
const ROW = "0b8f3a52-2f5c-4f0e-9a51-5d1b1c7f0a11";

describe("saving custom fields", () => {
  beforeEach(() => {
    state.saves = 0;
    state.checked = [];
  });

  it("refuses a Field or Viewer member before writing", async () => {
    for (const role of ["field", "viewer", null]) {
      state.role = role;
      expect(
        await saveCustomFieldsAction(
          "acme",
          "app.vendors",
          ROW,
          { tier: { value: "gold" } },
          "update",
        ),
      ).toEqual({ ok: false, error: "denied" });
    }
    expect(state.saves).toBe(0);
  });

  it("writes for a Collaborator or higher", async () => {
    for (const role of ["collaborator", "owner"]) {
      state.role = role;
      expect(
        await saveCustomFieldsAction(
          "acme",
          "app.vendors",
          ROW,
          { tier: { value: "gold" } },
          "update",
        ),
      ).toEqual({ ok: true });
    }
    expect(state.saves).toBe(2);
  });

  it("holds a create form's post to required fields even when it sends no custom field input", async () => {
    const ctx = { org: { id: "org-1", slug: "acme" }, role: "member" } as unknown as Parameters<
      typeof customFieldsOf
    >[0];
    const form = new FormData();
    form.set("name", "Dock");
    const step = await customFieldsOf(ctx, "app.vendors", form);
    expect(step.fieldErrors).toEqual({ "cf.tier": "required" });
    expect(state.checked).toEqual([{ inputs: {}, dryRun: true }]);
    // A caller that shows no custom fields (a typed quick-add, an edit) passes none and is not held to them.
    expect((await customFieldsOf(ctx, "app.vendors", undefined)).fieldErrors).toBeNull();
    expect(state.checked).toHaveLength(1);
  });
});
