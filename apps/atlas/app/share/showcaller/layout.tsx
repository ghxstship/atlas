import type { ReactNode } from "react";

/**
 * The frame of a showcaller link's portal (B3, ADR 0142): no Atlas chrome and no account, the running order and
 * the console edge to edge. The root layout keeps the cookie banner off these pages, which set only the strictly
 * necessary grant cookie.
 */
export default function ShowcallerPortalLayout({ children }: { children: ReactNode }) {
  return (
    <main id="content" className="min-h-dvh bg-bg-canvas text-text-primary">
      {children}
    </main>
  );
}
