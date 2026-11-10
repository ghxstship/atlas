"use client";

import dynamic from "next/dynamic";

/**
 * Archive and Unarchive on a peek or a record page (A124), loaded when first rendered so no route
 * carries their code until a row is open (ADR 0027).
 */
export const ArchiveControls = dynamic(() =>
  import("./archive-controls-body").then((m) => m.ArchiveControlsBody),
);
