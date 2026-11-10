"use client";

import { lazy, Suspense, type ComponentProps } from "react";

const Actions = lazy(() =>
  import("./ownership-offer").then((m) => ({ default: m.OwnershipOfferActions })),
);

/**
 * The ownership offer's Accept and Decline (ownership-offer.tsx), fetched only on the banner that
 * shows them. The org banners are a server component in every org layout, and a client component
 * it imports directly loads with every org page whether or not an offer is open (ADR 0027). The
 * server renders the buttons; the browser hydrates them once their module arrives.
 */
export function OwnershipOfferActions(props: ComponentProps<typeof Actions>) {
  return (
    <Suspense fallback={null}>
      <Actions {...props} />
    </Suspense>
  );
}
