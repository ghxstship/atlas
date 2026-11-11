"use client";

import dynamic from "next/dynamic";

/** @xos/ui TreeView, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const TreeView = dynamic(() => import("./targets/tree-view").then((m) => m.TreeView));
