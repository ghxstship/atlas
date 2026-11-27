import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

interface Finding {
  readonly alert: number;
  readonly rule: string;
  readonly path: string;
  readonly verdict: string;
  readonly reason: string;
  readonly change: string;
}

const record = JSON.parse(readFileSync(join(here, "../codeql-findings.json"), "utf8")) as {
  readonly recorded: string;
  readonly findings: readonly Finding[];
};

describe("the CodeQL findings record", () => {
  it("names each alert once, with a rule, a file that exists, a verdict and a reason", () => {
    expect(record.recorded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const seen = new Set<number>();
    for (const finding of record.findings) {
      expect(Number.isInteger(finding.alert) && finding.alert > 0, String(finding.alert)).toBe(
        true,
      );
      expect(seen.has(finding.alert), `alert ${finding.alert} is listed twice`).toBe(false);
      seen.add(finding.alert);
      expect(finding.rule, `alert ${finding.alert}`).toMatch(/^(js|py)\/[a-z-]+$/);
      expect(existsSync(join(root, finding.path)), finding.path).toBe(true);
      expect(["real", "not_exploitable"], `alert ${finding.alert}`).toContain(finding.verdict);
      expect(finding.reason.length, `alert ${finding.alert} has no reason`).toBeGreaterThan(20);
    }
  });

  it("never leaves a real finding without a change", () => {
    for (const finding of record.findings) {
      if (finding.verdict === "real") {
        expect(finding.change.length, `alert ${finding.alert}`).toBeGreaterThan(0);
      }
    }
  });
});
