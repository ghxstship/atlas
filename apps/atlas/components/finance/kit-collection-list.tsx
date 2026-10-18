"use client";

import { RecordList, RecordRow } from "@xos/ui";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";
import { type ListItem } from "./kit.types";

/** The list view: rows answer what now, and Enter or a click opens the peek (Section 11.10 rule 4). */
export function CollectionList({ label, items }: { label: string; items: readonly ListItem[] }) {
  const go = useQueryNav();
  const t = useFinanceT();
  return (
    <RecordList label={label}>
      {items.map((item) => (
        <RecordRow
          key={item.id}
          recordKey={item.recordKey}
          title={item.title}
          state={item.state}
          stateLabel={item.stateLabel}
          {...(item.next ? { next: item.next } : {})}
          {...(item.owner ? { owner: item.owner } : {})}
          actionLabel={t("common.open")}
          onAction={() => go({ peek: item.id })}
          onOpen={() => go({ peek: item.id })}
        />
      ))}
    </RecordList>
  );
}
