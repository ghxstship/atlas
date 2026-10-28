"use client";

import dynamic from "next/dynamic";

/** @xos/ui Calendar, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const Calendar = dynamic(() => import("./targets/calendar").then((m) => m.Calendar));
