"use client";

import { Skeleton } from "@xos/ui";

/**
 * The loading state of a Projects, Home or Activity page: the header and rows it will fill. A
 * client module of its own: a route's loading boundary loads with every visit, and the shared
 * `./ui` boundary would bring every @xos/ui component the server pages render (ADR 0027).
 */
export function PageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-12">
      <Skeleton width={240} height={28} />
      <Skeleton width="60%" height={32} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width="100%" height={36} />
      ))}
    </div>
  );
}
