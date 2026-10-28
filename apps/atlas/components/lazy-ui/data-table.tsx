"use client";

import dynamic from "next/dynamic";

/** @xos/ui DataTable, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const DataTable = dynamic(() => import("./targets/data-table").then((m) => m.DataTable));
