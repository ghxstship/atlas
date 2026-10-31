import { ViewTransition, type ReactElement, type ReactNode } from "react";

/** The view transition class the route transition's CSS (styles/components.css) animates. */
export const ROUTE_TRANSITION_CLASS = "xos-route";

/**
 * The page region of a route, for an app's `template.tsx` (Section 11.7, ADR 0118). Next remounts a
 * template when the route below it changes, and the navigation is a React transition, so the page
 * that leaves fades out and the page that arrives fades in through the browser's View Transitions
 * API. Nothing else animates it: refreshes, search parameters and live updates keep the same
 * template, and `default="none"` keeps every other transition still. Under reduced motion the CSS
 * runs no animation, so the page swaps at once.
 *
 * It holds no state and no hooks, so a server template renders it and no route JavaScript is added.
 */
export function RouteTransition({ children }: { children: ReactNode }): ReactElement {
  return (
    <ViewTransition enter={ROUTE_TRANSITION_CLASS} exit={ROUTE_TRANSITION_CLASS} default="none">
      {children}
    </ViewTransition>
  );
}
