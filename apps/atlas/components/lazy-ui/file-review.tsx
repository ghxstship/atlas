"use client";

import dynamic from "next/dynamic";

/** File version review controls (B14, components/files/file-review.tsx), loaded when first rendered (ADR 0027). */
export const FileReviewControls = dynamic(() =>
  import("@/components/files/file-review").then((m) => m.FileReviewControls),
);
