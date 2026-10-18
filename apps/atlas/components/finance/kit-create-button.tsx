"use client";

import { Button } from "@xos/ui";
import { useQueryNav } from "./kit-use-query-nav";

/** Opens the create sheet: the page's one primary action (Section 11.10). */
export function CreateButton({ label }: { label: string }) {
  const go = useQueryNav();
  return (
    <Button variant="primary" icon="Plus" shortcut="C" onClick={() => go({ create: "1" })}>
      {label}
    </Button>
  );
}
