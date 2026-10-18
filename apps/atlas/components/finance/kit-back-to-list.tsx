"use client";

import { Button } from "@xos/ui";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";

/** The full page header's way back to the list, keeping filters. */
export function BackToList() {
  const t = useFinanceT();
  const go = useQueryNav();
  return (
    <Button variant="ghost" icon="ArrowLeft" onClick={() => go({ peek: null, full: null })}>
      {t("common.back")}
    </Button>
  );
}
