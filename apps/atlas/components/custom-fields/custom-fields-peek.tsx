"use client";

import dynamic from "next/dynamic";

/**
 * The custom fields section of a peek drawn in the browser (A117), loaded when a peek opens rather than with the
 * list page under it (A24-009). It takes the props of CustomFieldsSection and loads its own fields.
 */
export const CustomFieldsPeekSection = dynamic(() =>
  import("./custom-fields-section").then((m) => m.CustomFieldsSection),
);
