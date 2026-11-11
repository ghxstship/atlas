"use client";

import dynamic from "next/dynamic";

/** @xos/ui Dialog, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const Dialog = dynamic(() => import("./targets/dialog").then((m) => m.Dialog));
