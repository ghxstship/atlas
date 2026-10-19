import type { ReactElement } from "react";
import type { SkeletonProps as ReferenceSkeletonProps } from "../types/reference";

export type SkeletonProps = ReferenceSkeletonProps;

/**
 * Reserves space for streamed content; stops pulsing under reduced motion. A module of its own:
 * route loading boundaries render it on every visit, so it brings nothing else along (ADR 0027).
 */
export function Skeleton({ width, height }: SkeletonProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="xos-anim-pulse block rounded-chip bg-bg-hover"
      style={{
        inlineSize: width ?? "var(--ui-skeleton-inline)",
        blockSize: height ?? "var(--ui-skeleton-block)",
      }}
    />
  );
}
