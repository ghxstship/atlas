"use client";

import dynamic from "next/dynamic";

/** @xos/ui RecordList and RecordRow, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const RecordList = dynamic(() => import("./targets/record-list").then((m) => m.RecordList));
export const RecordRow = dynamic(() => import("./targets/record-list").then((m) => m.RecordRow));
