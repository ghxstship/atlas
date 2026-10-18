"use client";

import { Button } from "@xos/ui";
import { useQueryNav } from "./kit-use-query-nav";

export function EditButton({ label }: { label: string }) {
  const go = useQueryNav();
  return (
    <Button icon="Pencil" onClick={() => go({ edit: "1" })}>
      {label}
    </Button>
  );
}
