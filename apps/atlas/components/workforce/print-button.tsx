"use client";

import { Button } from "@xos/ui";

/** Prints the page with the browser's print dialog; hidden on the printed copy. */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button variant="secondary" className="print:hidden" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
