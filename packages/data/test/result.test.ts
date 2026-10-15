import { describe, expect, it } from "vitest";
import { fail, ok, rowRefusal, toDataError } from "../src/result.ts";

describe("toDataError", () => {
  it("splits a refusal into the rule and the sentence (ADR 0008)", () => {
    expect(
      toDataError({
        code: "XR001",
        message: "slug_taken: acme is already in use.",
        hint: "slug_taken",
      }),
    ).toEqual({ kind: "refusal", rule: "slug_taken", message: "acme is already in use." });
  });

  it("reads the rule from the message when the hint is missing", () => {
    expect(toDataError({ code: "XR001", message: "role_band: too high" })).toEqual({
      kind: "refusal",
      rule: "role_band",
      message: "too high",
    });
    expect(toDataError({ code: "XR001", message: "no separator" })).toEqual({
      kind: "refusal",
      rule: "refused",
      message: "no separator",
    });
  });

  it("maps authorization failures and empty single reads to not-found (ADR 0003)", () => {
    expect(toDataError({ code: "42501", message: "denied" })).toEqual({ kind: "not-found" });
    expect(toDataError({ code: "PGRST116", message: "no rows" })).toEqual({ kind: "not-found" });
  });

  it("maps unique and check violations", () => {
    expect(toDataError({ code: "23505", message: "dup" })).toEqual({
      kind: "conflict",
      message: "dup",
    });
    expect(toDataError({ code: "23514", message: "check" })).toEqual({
      kind: "invalid",
      message: "check",
    });
  });

  it("keeps everything else as unexpected, with or without a code", () => {
    expect(toDataError({ code: "08006", message: "down" })).toEqual({
      kind: "unexpected",
      message: "down",
      code: "08006",
    });
    expect(toDataError({ message: "fetch failed" })).toEqual({
      kind: "unexpected",
      message: "fetch failed",
    });
  });
});

describe("result helpers", () => {
  it("wraps data and errors", () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
    expect(fail({ kind: "not-found" })).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("turns a row refusal into a refusal error", () => {
    expect(rowRefusal("invite_invalid")).toEqual({
      kind: "refusal",
      rule: "invite_invalid",
      message: "invite_invalid",
    });
    expect(rowRefusal(null).kind).toBe("refusal");
  });
});
