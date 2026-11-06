"use client";

import dynamic from "next/dynamic";

/** The project wrap-up's summary, points and completion (B7), loaded when the Reports tab first renders it (ADR 0027). */
export const WrapUpPanel = dynamic(() =>
  import("@/components/reports/wrap-up-panel").then((m) => m.WrapUpPanel),
);
