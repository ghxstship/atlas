import type { ReactNode } from "react";
import type { RegionData } from "@/lib/shell/region-data";
import { Region, RegionFailed } from "./region";

/**
 * A region whose data a page loader read with the others (ADR 0118): its content when the read
 * succeeded, else Retry in its place, inside the Region that catches an error while it renders.
 * Works from server and client components alike.
 */
export function RegionContent<T>({
  data,
  onRetry,
  children,
}: {
  data: RegionData<T>;
  /** For a region outside the page; see RegionFailed. */
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}) {
  return (
    <Region>
      {data.ok ? (
        <Content data={data.data} render={children} />
      ) : (
        <RegionFailed {...(onRetry ? { onRetry } : {})} />
      )}
    </Region>
  );
}

/** Builds the content as a child of the Region, so an error while building it stays in the region. */
function Content<T>({ data, render }: { data: T; render: (data: T) => ReactNode }) {
  return render(data);
}
