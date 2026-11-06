"use client";

import dynamic from "next/dynamic";

/** Linking order lines, inside a need's record panel, which opens on a press. */
export const LinkOrderLinesForm = dynamic(() =>
  import("./needs-forms").then((m) => m.LinkOrderLinesForm),
);
