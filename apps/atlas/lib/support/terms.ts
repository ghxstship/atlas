import type { SupportChannel } from "@xos/data/support";

/**
 * The platform support channel each plan includes (Section 11.16), mirroring
 * private.platform_support_terms (migration 0643), which decides the stored channel and deadline.
 * Null for the Access plan, which has the help center and community forum only.
 */
export function platformChannel(planCode: string | null): SupportChannel | null {
  switch (planCode) {
    case "core":
      return "Email";
    case "pro":
      return "Chat";
    case "team":
      return "Priority Queue";
    case "enterprise":
      return "Dedicated Channel";
    default:
      return null;
  }
}
