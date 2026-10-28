"use client";

import dynamic from "next/dynamic";

/** @xos/ui Drawer, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const Drawer = dynamic(() => import("./targets/drawer").then((m) => m.Drawer));
