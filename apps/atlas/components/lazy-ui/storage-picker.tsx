"use client";

import dynamic from "next/dynamic";

/** B16's storage picker (components/integrations/storage-picker.tsx), loaded when first rendered (ADR 0027). */
export const StoragePicker = dynamic(() =>
  import("@/components/integrations/storage-picker").then((m) => m.StoragePicker),
);

/** Removing a linked file, loaded with the picker's module when first rendered. */
export const LinkedFileRemove = dynamic(() =>
  import("@/components/integrations/storage-picker").then((m) => m.LinkedFileRemove),
);
