"use client";

import dynamic from "next/dynamic";

/** @xos/ui PropertyList, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const PropertyList = dynamic(() =>
  import("./targets/property-list").then((m) => m.PropertyList),
);
