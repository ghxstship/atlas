"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { RegionBoundary, RegionError } from "@xos/ui";
import { unstable_rethrow, usePathname, useRouter } from "next/navigation";
import { startTransition, Suspense, type ReactNode } from "react";

/** Next's redirect, not found and client-render bailout errors belong to the boundaries above. */
function isNextControlFlow(error: unknown): boolean {
  try {
    unstable_rethrow(error);
    return false;
  } catch {
    return true;
  }
}

/**
 * One region of a page that fails alone (Section 11.7, ADR 0118): a dashboard tile, a record panel or
 * a peek section. An error while it renders, including one a server component inside it threw, shows
 * Retry in its place and goes to the browser error reporter; the page around it keeps working. Retry
 * fetches the route again and renders the region in the same transition, so a server error can
 * recover too. A navigation clears the error.
 *
 * The children render inside a Suspense boundary: while the page renders on the server, an error an
 * async server child throws stops at it, the region renders again in the browser and this boundary
 * catches it there, instead of the whole page going to the route's error page. `fallback` shows
 * while such a child loads.
 */
export function Region({
  title,
  fallback = null,
  children,
}: {
  title?: string;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <RegionBoundary
      {...(title ? { title } : {})}
      resetKey={pathname}
      passThrough={isNextControlFlow}
      onError={(error) => reportClientError(error)}
      onRetry={(reset) =>
        startTransition(() => {
          router.refresh();
          reset();
        })
      }
    >
      <Suspense fallback={fallback}>{children}</Suspense>
    </RegionBoundary>
  );
}

/**
 * What a region shows when its loader could not read its data (RegionData, lib/shell/region-data.ts):
 * the same alert and Retry as a region that threw. The loader reported the error on the server.
 * Retry fetches the route again, or calls `onRetry` for a region outside the page, such as the
 * shell's peek, which reads its record again.
 */
export function RegionFailed({ title, onRetry }: { title?: string; onRetry?: () => void }) {
  const router = useRouter();
  return (
    <RegionError
      {...(title ? { title } : {})}
      onRetry={onRetry ?? (() => startTransition(() => router.refresh()))}
    />
  );
}
