"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { RegionBoundary } from "@xos/ui";
import { unstable_rethrow, usePathname, useRouter } from "next/navigation";
import { startTransition, type ReactNode } from "react";

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
 */
export function Region({ title, children }: { title?: string; children: ReactNode }) {
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
      {children}
    </RegionBoundary>
  );
}
