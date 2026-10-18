import { compassPathForIncoming } from "@xos/ia/handoff";

/**
 * Incoming links (expo-router native intent, ADR 0030): a Continue on another device link in any form,
 * the compass:// scheme link or a universal link to an Atlas record or Gateway engagement page, opens
 * the Compass route for the same item. Every other link passes through to the router unchanged.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return compassPathForIncoming(path);
}
