"use client";

import dynamic from "next/dynamic";

/** @xos/ui Chart, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const Chart = dynamic(() => import("./targets/chart").then((m) => m.Chart));
