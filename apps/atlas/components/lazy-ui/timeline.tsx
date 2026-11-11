"use client";

import dynamic from "next/dynamic";

/** @xos/ui Timeline, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const Timeline = dynamic(() => import("./targets/timeline").then((m) => m.Timeline));
