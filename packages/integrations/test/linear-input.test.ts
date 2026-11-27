import { describe, expect, it } from "vitest";
import { driveQueryLiteral } from "../src/connectors/storage/index.ts";
import { decimalToMinor } from "../src/framework/support.ts";
import { withoutLeading, withoutTrailing } from "../src/framework/text.ts";
import { isEmailShaped } from "../src/identity/scim.ts";
import { objectUrl } from "../src/warehouse/s3.ts";

/** Quadratic patterns take minutes at these sizes; one pass takes milliseconds. */
const CEILING_MS = 2_000;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("driveQueryLiteral", () => {
  it("escapes the backslash before the quote, so a value cannot close its string", () => {
    expect(driveQueryLiteral("fold'er")).toBe("fold\\'er");
    // Escaping the quote alone turned \' into \\' : an escaped backslash, then a quote that ends the string.
    const hostile = "x\\' or name contains '";
    const literal = driveQueryLiteral(hostile);
    expect(literal).toBe("x\\\\\\' or name contains \\'");
    // Every quote in the literal is escaped: an odd number of backslashes stands before it.
    for (const match of literal.matchAll(/(\\*)'/g)) {
      expect((match[1] ?? "").length % 2, literal).toBe(1);
    }
  });
});

describe("isEmailShaped", () => {
  it("accepts what the pattern accepted and nothing more", () => {
    const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const text of [
      "a@b.co",
      "a.b@c.d.e",
      "a@b",
      "a@.b",
      "a@b.",
      "@b.co",
      "a@@b.co",
      "a b@c.d",
      "a@b .co",
      "",
      "a@b..c",
      "a@b.c\n",
    ]) {
      expect(isEmailShaped(text), JSON.stringify(text)).toBe(pattern.test(text));
    }
  });

  it("reads a long address from an identity provider once", () => {
    const { value, ms } = timed(() => isEmailShaped(`a@${"!.".repeat(200_000)}@`));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(CEILING_MS);
  });
});

describe("withoutTrailing and withoutLeading", () => {
  it("trim one character from one end", () => {
    expect(withoutTrailing("12.500", "0")).toBe("12.5");
    expect(withoutTrailing("000", "0")).toBe("");
    expect(withoutLeading(withoutTrailing("//Users/7//", "/"), "/")).toBe("Users/7");
    expect(withoutLeading("abc", "/")).toBe("abc");
  });

  it("read a long run once, where it ends the text or not", () => {
    const { ms } = timed(() => {
      expect(withoutTrailing(`${"/".repeat(400_000)}x`, "/")).toHaveLength(400_001);
      expect(() => decimalToMinor(`1.${"0".repeat(400_000)}x`, 2)).toThrow();
      expect(decimalToMinor(`1.5${"0".repeat(400_000)}`, 2)).toBe(150n);
      expect(
        objectUrl(
          {
            bucket: "b",
            region: null,
            endpointUrl: `https://s3.test${"/".repeat(100_000)}`,
          } as never,
          "k",
        ).href,
      ).toBe("https://s3.test/b/k");
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });
});
