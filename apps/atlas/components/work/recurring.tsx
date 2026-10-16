"use client";

import type { RecordSummary } from "@xos/data/work";
import {
  Button,
  Calendar,
  DataTable,
  EmptyState,
  PageHeader,
  RecordList,
  RecordRow,
  Tag,
  TemplateCollection,
  type RecordKind,
} from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useCopy } from "./action-ui";
import { formatWhen, stateToken, withQuery } from "./format";
import { shiftMonth } from "./record-collection";
import { CollectionViews } from "@/components/views/collection-views";

export interface RecurringItem {
  readonly record: RecordSummary;
  readonly rule: string;
  readonly timeZone: string;
  readonly next: readonly { at: string; label: string }[];
}

/**
 * Work > Recurring (Section 4.5.5): records that repeat, with their rule and next occurrences, as a
 * list, table or calendar of occurrences. The rule is edited on the record, so rows open its peek.
 */
export function RecurringCollection({
  org,
  title,
  items,
  views,
  view,
  month,
  today,
  peek,
}: {
  org: string;
  title: string;
  items: readonly RecurringItem[];
  views: readonly string[];
  view: string;
  month: string;
  today: string;
  peek: ReactNode;
}) {
  const t = useCopy("work");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const open = (key: string) =>
    router.push(withQuery(pathname, params, { peek: key }) as Route, { scroll: false });
  const upcoming = (i: RecurringItem) =>
    i.next
      .filter((n) => n.at >= `${today}T00:00:00`)
      .slice(0, 3)
      .map((n) => n.label)
      .join(", ");

  const header = (
    <PageHeader
      title={title}
      count={items.length}
      views={
        views.length > 1 ? (
          <CollectionViews
            label={t("collection.views")}
            value={view}
            options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            onChange={(v) => go({ view: v })}
          />
        ) : undefined
      }
    />
  );

  let body: ReactNode;
  if (items.length === 0) {
    body = (
      <EmptyState
        icon="Repeat"
        sentence={t("empty.recurring.sentence")}
        actionLabel={t("empty.recurring.action")}
        onAction={() => router.push(`/${org}/work/all-records` as Route)}
      />
    );
  } else if (view === "table") {
    body = (
      <DataTable
        caption={title}
        columns={[
          { key: "key", label: t("columns.key"), type: "code" },
          { key: "title", label: t("columns.title"), wrap: true },
          { key: "state", label: t("columns.state"), type: "state" },
          { key: "rule", label: t("columns.rule"), type: "code" },
          { key: "next", label: t("columns.next"), wrap: true },
        ]}
        rows={items.map((i) => ({
          id: i.record.key,
          key: i.record.key,
          title: i.record.title,
          state: { state: stateToken(i.record.state), label: t(`states.${i.record.state}`) },
          rule: i.rule,
          next: upcoming(i) || t("values.noDate"),
        }))}
        onRowActivate={(row) => open(String(row["key"]))}
      />
    );
  } else if (view === "calendar") {
    const byLabel = new Map<string, string>();
    const events = items.flatMap((i) =>
      i.next.flatMap((n) => {
        const date =
          formatWhen(n.at, "en-CA", i.timeZone, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }) ?? "";
        if (!date.startsWith(month.slice(0, 7))) return [];
        const label = `${i.record.key} ${i.record.title}`;
        byLabel.set(label, i.record.key);
        return [{ date, label, state: stateToken(i.record.state) }];
      }),
    );
    body = (
      <div className="flex flex-col gap-8">
        <div className="flex gap-8">
          <Button onClick={() => go({ month: shiftMonth(month, -1) })}>
            {t("collection.previousMonth")}
          </Button>
          <Button onClick={() => go({ month: shiftMonth(month, 1) })}>
            {t("collection.nextMonth")}
          </Button>
        </div>
        <Calendar
          month={month}
          today={today}
          events={events}
          onEventSelect={(e) => {
            const key = byLabel.get(e.label);
            if (key) open(key);
          }}
        />
      </div>
    );
  } else {
    body = (
      <RecordList label={title}>
        {items.map((i) => (
          <RecordRow
            key={i.record.id}
            state={stateToken(i.record.state)}
            stateLabel={t(`states.${i.record.state}`)}
            recordKey={i.record.key}
            kind={i.record.kind as RecordKind}
            title={i.record.title}
            chips={<Tag>{i.rule}</Tag>}
            {...(upcoming(i) ? { next: upcoming(i) } : {})}
            actionLabel={t("collection.open")}
            onAction={() => open(i.record.key)}
            onOpen={() => open(i.record.key)}
          />
        ))}
      </RecordList>
    );
  }

  return (
    <TemplateCollection header={header} peek={peek}>
      {body}
    </TemplateCollection>
  );
}
