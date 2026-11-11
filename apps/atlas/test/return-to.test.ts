import { describe, expect, it } from "vitest";
import { returnHref } from "@/lib/finance/return-to";

describe("returnHref", () => {
  it("keeps a path inside the org with its query, and adds what the server knows", () => {
    expect(returnHref("/demo/finance/payments?tab=due&notice=x", "demo")).toBe(
      "/demo/finance/payments?tab=due&notice=x",
    );
    expect(returnHref("/demo/finance/expenses?peek=a", "demo", { peek: "b" })).toBe(
      "/demo/finance/expenses?peek=b",
    );
  });

  it("answers null for anything that would leave the org", () => {
    for (const value of [
      null,
      "",
      "https://evil.example/demo/x",
      "//evil.example/demo/x",
      "/other/finance",
      "/demo/../other/finance",
      "/demo/..//evil.example",
    ]) {
      expect(returnHref(value, "demo")).toBeNull();
    }
  });
});
