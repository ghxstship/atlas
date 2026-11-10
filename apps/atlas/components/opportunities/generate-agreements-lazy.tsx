"use client";

import dynamic from "next/dynamic";

/** The batch form, shown only after someone presses Generate agreements (?generate=1). */
export const GenerateAgreements = dynamic(() =>
  import("./generate-agreements").then((m) => m.GenerateAgreements),
);
