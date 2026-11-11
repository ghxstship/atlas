import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B13 (RRR-237, G-133, C5): the shift form's Budget line reaches the write on every path the actions take:
 * members and agency slots through createShift and updateShift, staff and held shifts through
 * saveRosterShift. A blank choice is an explicit null, which is how a person clears the link.
 */

const state = vi.hoisted(() => ({
  createShift: vi.fn(),
  updateShift: vi.fn(),
  saveRosterShift: vi.fn(),
  getShift: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({ org: { id: "org", slug: "acme" }, viewer: { db: {} } }),
}));
vi.mock("@/lib/shell/translate", () => ({ getTranslate: async () => (key: string) => key }));
vi.mock("@xos/data/crew", () => ({
  createShift: state.createShift,
  updateShift: state.updateShift,
  saveRosterShift: state.saveRosterShift,
  getShift: state.getShift,
}));

const { createShiftAction, updateShiftAction } = await import("@/app/[org]/crew/actions");

const uuid = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const LINE = uuid(1);
const PROJECT = uuid(2);
const MEMBER = uuid(3);
const ENGAGEMENT = uuid(4);
const ENTRY = uuid(5);
const SHIFT = uuid(6);

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  const all = {
    org: "acme",
    timeZone: "UTC",
    startsAt: "2027-06-01T08:00",
    endsAt: "2027-06-01T16:00",
    roleCode: "",
    ...values,
  };
  for (const [k, v] of Object.entries(all)) data.set(k, v);
  return data;
}
const created = (values: Record<string, string>) =>
  createShiftAction({}, form({ projectId: PROJECT, ...values }));
const edited = (values: Record<string, string>) =>
  updateShiftAction({}, form({ id: SHIFT, ...values }));
const holds = (rosterEntryId: string | null) =>
  state.getShift.mockResolvedValue({ ok: true, data: { rosterEntryId, projectId: PROJECT } });
const lineOf = (mock: { mock: { calls: unknown[][] } }) =>
  (mock.mock.calls[0]?.at(-1) as { budgetLineId?: unknown }).budgetLineId;

beforeEach(() => {
  for (const mock of [state.createShift, state.updateShift, state.saveRosterShift]) {
    mock.mockReset();
    mock.mockResolvedValue({ ok: true, data: { id: SHIFT } });
  }
  state.getShift.mockReset();
  holds(null);
});

describe("createShiftAction's budget line", () => {
  it("reaches a member's shift", async () => {
    await created({ membershipId: MEMBER, budgetLineId: LINE });
    expect(state.createShift.mock.calls[0]?.[1]).toMatchObject({
      membershipId: MEMBER,
      budgetLineId: LINE,
    });
    expect(state.saveRosterShift).not.toHaveBeenCalled();
  });

  it("reaches an agency slot and an open shift", async () => {
    await created({ membershipId: `agency:${ENGAGEMENT}`, budgetLineId: LINE });
    expect(state.createShift.mock.calls[0]?.[1]).toMatchObject({
      engagementId: ENGAGEMENT,
      budgetLineId: LINE,
    });
    state.createShift.mockClear();
    await created({ membershipId: "", budgetLineId: LINE });
    expect(lineOf(state.createShift)).toBe(LINE);
  });

  it("reaches agency staff, saved in the placement's one transaction", async () => {
    await created({ membershipId: `staff:${ENTRY}:${ENGAGEMENT}`, budgetLineId: LINE });
    expect(state.saveRosterShift.mock.calls[0]?.[1]).toMatchObject({
      worker: { kind: "staff", rosterEntryId: ENTRY },
      budgetLineId: LINE,
    });
    expect(state.createShift).not.toHaveBeenCalled();
  });

  it("is null when none is chosen", async () => {
    await created({ membershipId: MEMBER, budgetLineId: "" });
    expect(lineOf(state.createShift)).toBeNull();
  });

  it("refuses a value that is not a line, and writes nothing", async () => {
    const result = await created({ membershipId: MEMBER, budgetLineId: "not-a-line" });
    expect(result.fieldErrors).toHaveProperty("budgetLineId");
    expect(state.createShift).not.toHaveBeenCalled();
  });
});

describe("updateShiftAction's budget line", () => {
  it("reaches a member's shift, and a blank choice clears it", async () => {
    await edited({ membershipId: MEMBER, budgetLineId: LINE });
    expect(state.updateShift.mock.calls[0]?.[2]).toMatchObject({
      membershipId: MEMBER,
      budgetLineId: LINE,
    });
    state.updateShift.mockClear();
    await edited({ membershipId: MEMBER, budgetLineId: "" });
    expect(lineOf(state.updateShift)).toBeNull();
  });

  it("reaches an agency slot", async () => {
    await edited({ membershipId: `agency:${ENGAGEMENT}`, budgetLineId: LINE });
    expect(state.updateShift.mock.calls[0]?.[2]).toMatchObject({
      engagementId: ENGAGEMENT,
      budgetLineId: LINE,
    });
    expect(state.saveRosterShift).not.toHaveBeenCalled();
  });

  it("reaches a roster shift whose person stays", async () => {
    holds(ENTRY);
    await edited({ membershipId: `staff:${ENTRY}`, budgetLineId: LINE });
    expect(lineOf(state.updateShift)).toBe(LINE);
    expect(state.saveRosterShift).not.toHaveBeenCalled();
  });

  it("reaches a shift moved onto the roster", async () => {
    await edited({ membershipId: `staff:${ENTRY}:${ENGAGEMENT}`, budgetLineId: LINE });
    expect(lineOf(state.saveRosterShift)).toBe(LINE);
    expect(state.updateShift).not.toHaveBeenCalled();
  });

  it("reaches a shift taken off the roster, and a blank choice clears it there too", async () => {
    holds(ENTRY);
    await edited({ membershipId: MEMBER, budgetLineId: LINE });
    expect(state.saveRosterShift.mock.calls[0]?.[1]).toMatchObject({
      shiftId: SHIFT,
      worker: { kind: "member", membershipId: MEMBER },
      budgetLineId: LINE,
    });
    state.saveRosterShift.mockClear();
    await edited({ membershipId: MEMBER, budgetLineId: "" });
    expect(lineOf(state.saveRosterShift)).toBeNull();
  });

  it("refuses a value that is not a line, and writes nothing", async () => {
    const result = await edited({ membershipId: MEMBER, budgetLineId: "not-a-line" });
    expect(result.fieldErrors).toHaveProperty("budgetLineId");
    expect(state.updateShift).not.toHaveBeenCalled();
  });
});
