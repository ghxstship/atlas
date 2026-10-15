"use client";

import { Skeleton } from "@xos/ui";

/** The Collection template's regions as skeletons: header, filter row and five rows. */
export function OpportunitiesSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-12">
      <Skeleton width="40%" height={24} />
      <Skeleton width="60%" height={16} />
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} width="100%" height={36} />
      ))}
    </div>
  );
}
