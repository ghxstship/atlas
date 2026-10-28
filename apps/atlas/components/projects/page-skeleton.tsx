import { Skeleton } from "@xos/ui/static";

/**
 * The loading state of a Projects, Home or Activity page: the header and rows it will fill. Server
 * rendered from the hook-free `@xos/ui/static`, so the loading boundaries that use it send no
 * JavaScript; a client module here loaded with every visit to the route (ADR 0027).
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
