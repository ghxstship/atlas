"use client";

import dynamic from "next/dynamic";

/** A record's review section (B14, components/work/record-review.tsx), loaded when first rendered (ADR 0027). */
export const RecordReview = dynamic(() => import("@/components/work/record-review").then((m) => m.RecordReview));
