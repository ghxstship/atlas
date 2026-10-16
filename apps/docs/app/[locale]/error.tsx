"use client";

import { useEffect } from "react";
import { useBoundaryCopy } from "@/components/error-copy.tsx";

/** A page that failed to render: says so, and offers to try again. */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const copy = useBoundaryCopy().error;
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <section
      role="alert"
      className="flex flex-col items-start gap-12 py-32 max-w-(--layout-reading)"
    >
      <h1 className="m-0 text-heading-24 font-semibold">{copy.title}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{copy.sentence}</p>
      <button
        type="button"
        onClick={reset}
        className="h-control-md px-12 rounded-control border border-border-control bg-bg-raised text-text-13 text-text-primary cursor-pointer hover:bg-bg-hover"
      >
        {copy.action}
      </button>
    </section>
  );
}
