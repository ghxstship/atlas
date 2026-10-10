import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core over a rendered tree and fails on any serious or critical finding (Section 15,
 * design handoff gate 2). Color contrast needs layout and computed colors that jsdom does not
 * provide; the token contrast gate and the browser audits cover it.
 */
export async function expectAccessible(node: Element = document.body): Promise<void> {
  const results = await axe.run(node, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking).toEqual([]);
}
