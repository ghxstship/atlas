import type { ReactNode } from "react";

/**
 * The public frame of a live view link (P1, ADR 0130): no shell, no session. The page draws the
 * org's brand heading from the link's Public brand columns and "Powered by XOS" unless the org
 * suppresses it.
 */
export default function LiveViewLayout({ children }: { children: ReactNode }) {
  return (
    <main id="content" className="min-h-dvh bg-bg-canvas px-16 py-24 sm:px-24">
      <div className="mx-auto flex max-w-layout-reading flex-col gap-24">{children}</div>
    </main>
  );
}
