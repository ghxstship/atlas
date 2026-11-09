"use client";

import { Button } from "@xos/ui";
import dynamic from "next/dynamic";
import { useState, type ComponentProps } from "react";
import type { ConsolidateForm as Form } from "./needs-forms";

/** Linking order lines, inside a need's record panel, which opens on a press. */
export const LinkOrderLinesForm = dynamic(() =>
  import("./needs-forms").then((m) => m.LinkOrderLinesForm),
);

const ConsolidateForm = dynamic(() => import("./needs-forms").then((m) => m.ConsolidateForm));

/** Consolidating requests onto a need: its form loads when someone presses to choose. */
export function ConsolidateEntry({
  label,
  ...props
}: ComponentProps<typeof Form> & { readonly label: string }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <ConsolidateForm {...props} />
  ) : (
    <div>
      <Button type="button" onClick={() => setOpen(true)}>
        {label}
      </Button>
    </div>
  );
}
