"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect } from "react";
import { handOffPeek } from "@/lib/shell/peek-handoff";

/**
 * Rendered by a collection that shows no row for the URL's `?peek` key: hands the key to the shell's
 * peek, which opens the record it names or says it is not one the viewer can open. It registers in a
 * layout effect, so the shell decides in the same commit that renders the collection.
 */
export function PeekHandoff({ recordKey }: { recordKey: string }) {
  const pathname = usePathname();
  useLayoutEffect(() => handOffPeek(pathname, recordKey), [pathname, recordKey]);
  return null;
}
