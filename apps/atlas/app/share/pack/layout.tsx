import type { ReactNode } from "react";

/**
 * The public frame of a stakeholder pack (B2, ADR 0141): no shell, no session. The page draws the org's
 * brand heading from the pack's Public brand columns and "Powered by XOS" unless the org suppresses it.
 */
export default function StakeholderPackLayout({ children }: { children: ReactNode }) {
  return (
    <main id="content" className="min-h-dvh bg-bg-canvas px-16 py-24 sm:px-24">
      <div className="mx-auto flex max-w-layout-reading flex-col gap-24">{children}</div>
    </main>
  );
}
