"use client";

import { Drawer } from "@xos/ui";
import { type ReactNode } from "react";
import { useQueryNav } from "./kit-use-query-nav";

// Create and edit sheet ------------------------------------------------------------------------------

/** A sheet opened by `?create=1` or `?edit=1` (ADR 0017 item 4); closing clears the flag. */
export function FormSheet({
  title,
  flag,
  children,
}: {
  title: string;
  flag: string;
  children: ReactNode;
}) {
  const go = useQueryNav();
  return (
    <Drawer
      title={title}
      open
      onOpenChange={(open) => {
        if (!open) go({ [flag]: null }, true);
      }}
    >
      {children}
    </Drawer>
  );
}
