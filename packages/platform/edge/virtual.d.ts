/**
 * The plan registry the Edge bundle build embeds (edge/build.ts): packages/schemas/plans.yaml, parsed
 * and validated when the bundle is built.
 */
declare module "virtual:xos-plan-registry" {
  import type { PlanRegistry } from "@xos/schemas/plans";

  export const planRegistry: PlanRegistry;
}
