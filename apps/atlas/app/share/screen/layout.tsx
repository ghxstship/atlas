import type { ReactNode } from "react";

/**
 * The frame of a display screen link (P1, ADR 0130): full bleed and dark, with no chrome, so a TV
 * shows the clock and cues edge to edge. The root layout keeps the cookie banner off these pages,
 * which set only the strictly necessary grant cookie.
 */
export default function DisplayScreenLayout({ children }: { children: ReactNode }) {
  return (
    <main id="content" data-theme="dark" className="min-h-dvh bg-bg-canvas text-text-primary">
      {children}
    </main>
  );
}
