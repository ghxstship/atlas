"use client";

import dynamic from "next/dynamic";

/** @xos/ui BulkActionBar, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const BulkActionBar = dynamic(() =>
  import("./targets/bulk-action-bar").then((m) => m.BulkActionBar),
);
