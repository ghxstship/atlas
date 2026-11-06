"use client";

import dynamic from "next/dynamic";

/** The Books panel's New book, Edit and Delete (B7), loaded when the panel first renders it (ADR 0027). */
export const BookEditor = dynamic(() =>
  import("@/components/projects/book-editor").then((m) => m.BookEditor),
);
