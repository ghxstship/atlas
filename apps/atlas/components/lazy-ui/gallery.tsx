"use client";

import dynamic from "next/dynamic";

/** @xos/ui Gallery, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const Gallery = dynamic(() => import("./targets/gallery").then((m) => m.Gallery));
