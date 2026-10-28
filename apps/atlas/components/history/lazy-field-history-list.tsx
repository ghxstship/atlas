"use client";

import dynamic from "next/dynamic";

/**
 * The field history list (DiffViewer), loaded when first rendered rather than with the page
 * (A24-009, ADR 0027): record pages and peeks show it below the record, and list pages that can
 * open a peek must not carry its code.
 */
export const LazyFieldHistoryList = dynamic(() =>
  import("./field-history-list").then((m) => m.FieldHistoryList),
);
