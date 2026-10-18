"use client";

import { Skeleton } from "@xos/ui";

/**
 * The loading skeleton of Finance and Reports pages. A segment's loading boundary is a sibling of its
 * pages, so every module it imports ships a second time beside theirs; it imports only Skeleton
 * (ADR 0027, A24-009).
 */
export function LoadingPanel({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-8">
      <Skeleton height={28} width="40%" />
      <Skeleton height={36} />
      <Skeleton height={36} />
      <Skeleton height={36} />
      <Skeleton height={36} />
    </div>
  );
}
