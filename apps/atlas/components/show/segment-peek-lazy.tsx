"use client";

import dynamic from "next/dynamic";

/** The peek of a library segment, opened from a row (B3): its dialogs and pickers stay out of the collection's weight. */
export const SegmentPeek = dynamic(() => import("./segment-peek").then((m) => m.SegmentPeek));
