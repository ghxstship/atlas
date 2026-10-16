import axe from "axe-core";
import { expect } from "vitest";
import type { ActionResult } from "../src/index.ts";

/**
 * Test labels: every string key reads as its own name, the listed keys are formatters that echo
 * their arguments, and the listed maps read as "map.key". Screens never see raw copy this way, so a
 * test that finds "acknowledge" knows the screen used the acknowledge label.
 */
export function labels<T>(
  fns: readonly string[] = [],
  maps: readonly string[] = [],
  overrides: Readonly<Record<string, unknown>> = {},
): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const key = String(prop);
        if (Object.hasOwn(overrides, key)) return overrides[key];
        if (fns.includes(key))
          return (...args: unknown[]) => `${key}(${args.map((a) => JSON.stringify(a)).join(",")})`;
        if (maps.includes(key)) return new Proxy({}, { get: (_t, sub) => `${key}.${String(sub)}` });
        return key;
      },
      has: () => true,
    },
  ) as T;
}

export const ok = (): Promise<ActionResult> => Promise.resolve({ ok: true });
export const refused = (message: string) => (): Promise<ActionResult> =>
  Promise.resolve({ ok: false, message });

export async function expectAccessible(node: Element): Promise<void> {
  const results = await axe.run(node, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking).toEqual([]);
}

/** The element at an index (negative counts from the end); fails the test when it is missing. */
export function at<T>(list: readonly T[], index: number): T {
  const value = list.at(index);
  if (value === undefined) throw new Error(`No element at ${index} of ${list.length}`);
  return value;
}

export const AUDIENCE = {
  kind: "Organization",
  projectId: null,
  teamId: null,
  roleId: null,
  groupId: null,
} as const;
