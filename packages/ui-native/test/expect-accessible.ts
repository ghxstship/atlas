import axe from "axe-core";
import { expect } from "vitest";

/* axe-core allows one run at a time. A run outliving its test (a slow CI runner hitting the
   timeout) would otherwise fail every later check with "Axe is already running", so runs queue. */
let queue: Promise<unknown> = Promise.resolve();

/** No serious or critical axe violations in `node` (contrast is checked on the web tokens). */
export async function expectAccessible(node: Element): Promise<void> {
  const run = queue.then(() =>
    axe.run(node, {
      rules: { "color-contrast": { enabled: false } },
      resultTypes: ["violations"],
    }),
  );
  queue = run.catch(() => undefined);
  const results = await run;
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking).toEqual([]);
}
