"use client";

import type { Baseline, BaselineVariance } from "@xos/data/schedule";
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  PageHeader,
  RecordList,
  RecordRow,
  StateChip,
  Tag,
  TemplateCollection,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useLocale } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useCopy } from "@/components/work/action-ui";
import { formatScheduleTime, slipAmount, stateToken, withQuery } from "@/components/work/format";
import { useScheduleView } from "@/components/work/use-schedule-view";
import { CollectionViews } from "@/components/views/collection-views";

/**
 * Schedule > Baselines (Section 4.5.5): captured baselines as a list or table. Capturing copies
 * every dated record's window and locks the baseline; the peek compares each record's planned
 * finish with its current one, so a slip shows in days (journey 14).
 */
export function BaselineCollection({
  org,
  title,
  baselines,
  views,
  view,
  canCapture,
  capture,
  peek,
}: {
  org: string;
  title: string;
  baselines: readonly Baseline[];
  views: readonly string[];
  view: string;
  canCapture: boolean;
  capture: ReactNode;
  peek: ReactNode;
}) {
  const t = useCopy("schedule");
  const w = useCopy("work");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const open = (id: string) =>
    router.push(withQuery(pathname, params, { peek: id }) as Route, { scroll: false });
  const captured = (b: Baseline) =>
    b.lockedAt
      ? format.dateTime(new Date(b.lockedAt), { dateStyle: "medium", timeStyle: "short" })
      : t("baselines.unlocked");

  const header = (
    <PageHeader
      title={title}
      count={baselines.length}
      views={
        views.length > 1 ? (
          <CollectionViews
            label={t("baselines.label")}
            value={view}
            options={views.map((v) => ({ value: v, label: w(`views.${v}`) }))}
            onChange={(v) => go({ view: v })}
          />
        ) : undefined
      }
      actions={canCapture ? capture : undefined}
    />
  );

  let body: ReactNode;
  if (baselines.length === 0) {
    body = (
      <EmptyState
        icon="Camera"
        sentence={canCapture ? t("baselines.empty") : t("baselines.emptyReadOnly")}
        actionLabel={canCapture ? t("baselines.emptyAction") : t("baselines.readOnlyAction")}
        onAction={() =>
          canCapture ? go({ create: "1" }) : router.push(`/${org}/schedule/timeline` as Route)
        }
      />
    );
  } else if (view === "table") {
    body = (
      <DataTable
        caption={t("baselines.label")}
        columns={[
          { key: "name", label: t("baselines.columns.name") },
          { key: "project", label: t("baselines.columns.project"), type: "code" },
          { key: "captured", label: t("baselines.columns.captured") },
          { key: "records", label: t("baselines.columns.records"), type: "number" },
        ]}
        rows={baselines.map((b) => ({
          id: b.id,
          name: b.name,
          project: b.projectKey,
          captured: captured(b),
          records: b.itemCount,
        }))}
        onRowActivate={(row) => open(String(row["id"]))}
      />
    );
  } else {
    body = (
      <RecordList label={t("baselines.label")}>
        {baselines.map((b) => (
          <RecordRow
            key={b.id}
            state={b.lockedAt ? "complete" : "proposed"}
            stateLabel={b.lockedAt ? t("baselines.locked") : t("baselines.unlocked")}
            recordKey={b.projectKey}
            title={b.name}
            chips={<Tag>{t("baselines.count", { count: b.itemCount })}</Tag>}
            next={captured(b)}
            actionLabel={t("baselines.open")}
            onAction={() => open(b.id)}
            onOpen={() => open(b.id)}
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

/** One baseline's records: planned and current finish, and the slip in days. */
export function BaselinePeek({
  baseline,
  variance,
  children,
}: {
  baseline: Baseline;
  variance: readonly BaselineVariance[];
  children?: ReactNode;
}) {
  const t = useCopy("schedule");
  const w = useCopy("work");
  const locale = useLocale();
  const view = useScheduleView();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const slip = (ms: number | null) => {
    if (ms === null) return t("baselines.noDate");
    const amount = slipAmount(ms);
    if (!amount) return t("baselines.onPlan");
    const key = `${amount.late ? "late" : "early"}${amount.unit === "hours" ? "Hours" : ""}`;
    return t(`baselines.${key}`, { n: amount.n });
  };
  const late = variance.filter((v) => (v.endSlipMs ?? 0) > 0).length;
  return (
    <Drawer
      title={t("baselines.peekTitle", { name: baseline.name, project: baseline.projectKey })}
      open
      onOpenChange={(open) => {
        if (!open)
          router.replace(withQuery(pathname, params, { peek: null }) as Route, { scroll: false });
      }}
    >
      <p className="m-0 text-text-13 text-text-secondary">
        {t("baselines.lateCount", { count: late })}
      </p>
      <h3 className="m-0 text-label-13 font-semibold">{t("baselines.variance")}</h3>
      <DataTable
        caption={t("baselines.varianceLabel")}
        columns={[
          { key: "key", label: w("columns.key"), type: "code" },
          { key: "title", label: w("columns.title"), wrap: true },
          { key: "state", label: w("columns.state"), type: "state" },
          { key: "planned", label: t("baselines.planned") },
          { key: "current", label: t("baselines.current") },
          { key: "slip", label: t("baselines.slip") },
        ]}
        rows={variance.map((v) => {
          const tz = v.record.timeZone ?? v.record.projectTimeZone;
          return {
            id: v.record.id,
            key: v.record.key,
            title: v.record.title,
            state: { state: stateToken(v.record.state), label: w(`states.${v.record.state}`) },
            planned: formatScheduleTime(v.plannedEnd, locale, tz, view) ?? t("baselines.noDate"),
            current:
              formatScheduleTime(
                v.record.endsAt ?? v.record.dueAt ?? v.record.startsAt,
                locale,
                tz,
                view,
              ) ?? t("baselines.noDate"),
            slip: slip(v.endSlipMs),
          };
        })}
      />
      <StateChip
        state={baseline.lockedAt ? "complete" : "proposed"}
        label={baseline.lockedAt ? t("baselines.locked") : t("baselines.unlocked")}
      />
      {children}
      <div>
        <Button
          onClick={() =>
            router.replace(withQuery(pathname, params, { peek: null }) as Route, { scroll: false })
          }
        >
          {t("baselines.close")}
        </Button>
      </div>
    </Drawer>
  );
}
