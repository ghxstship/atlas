import { describe, expect, it } from "vitest";
import { withholdIdentity } from "../src/redact.ts";

/** Two open-ended gaps around the optional separator took quadratic time on a run of spaces. */
const CEILING_MS = 2_000;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("withholdIdentity on long gaps", () => {
  it("withholds the value and keeps the label and its separator", () => {
    expect(withholdIdentity("Passport no: X1234567, DOB 01 Jan 1990")).toBe(
      "Passport no: [withheld], DOB [withheld]",
    );
    expect(withholdIdentity("KTN #  12345678")).toBe("KTN #  [withheld]");
    expect(withholdIdentity("passport  :  AB123")).toBe("passport  :  [withheld]");
  });

  it("reads a label followed by a long run of spaces once", () => {
    const hostile = `passport${" ".repeat(200_000)}!`.repeat(3);
    const { value, ms } = timed(() => withholdIdentity(hostile));
    expect(value).toBe(hostile);
    expect(ms).toBeLessThan(CEILING_MS);
  });
});
