"use client";

import { HoverCard } from "radix-ui";
import type { ReactNode } from "react";

/**
 * A canon term with its Bible definition in a hover card (Section 11.16, the in-product glossary):
 * opens after a short hover or on keyboard focus, closes on leave, blur or Esc. The definition comes
 * from the canon tables (for phases and gates, xpms.dim_phase.definition and gate_exit), never from
 * copy in the app. The trigger stays readable without the card; the glossary in Help lists every term.
 */
export function CanonTerm({
  term,
  definition,
  detail,
  children,
}: {
  term: string;
  definition: string | null;
  detail?: string | null;
  children: ReactNode;
}) {
  if (!definition) return <>{children}</>;
  return (
    <HoverCard.Root openDelay={400} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-chip outline-none focus-visible:ring-(length:--stroke-width-focus) focus-visible:ring-focus-ring"
        >
          {children}
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          className="z-popover flex w-(--ui-dialog) max-w-[calc(100vw-var(--space-32))] flex-col gap-4 rounded-card bg-bg-raised p-12 text-text-13 text-text-primary shadow-menu forced-colors:border"
        >
          <p className="m-0 font-semibold">{term}</p>
          <p className="m-0 text-text-secondary">{definition}</p>
          {detail ? <p className="m-0 text-text-12 text-text-secondary">{detail}</p> : null}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
