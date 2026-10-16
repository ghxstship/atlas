import { describe, expect, it } from "vitest";
import { must, optional } from "@/lib/projects/loaders";

describe("optional page parts (Field Lead project activity)", () => {
  it("leaves out a part the person may not see instead of failing the page", () => {
    expect(optional({ ok: false, error: { kind: "not-found" } }, "project activity")).toBeNull();
    expect(
      optional(
        { ok: false, error: { kind: "refusal", rule: "XR001", message: "No access" } },
        "project activity",
      ),
    ).toBeNull();
  });

  it("returns the data when the read succeeds", () => {
    expect(optional({ ok: true, data: [1, 2] }, "project activity")).toEqual([1, 2]);
  });

  it("still fails the page on an unexpected error", () => {
    const broken = { ok: false as const, error: { kind: "unexpected" as const, message: "down" } };
    expect(() => optional(broken, "project activity")).toThrow(/Cannot read project activity/);
    expect(() => must(broken, "project activity")).toThrow(/Cannot read project activity/);
  });
});
