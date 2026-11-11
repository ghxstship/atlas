"use client";

import type { LibrarySegment } from "@xos/data/segment-library";
import {
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  RecordList,
  RecordRow,
  Tag,
  TemplateCollection,
} from "@xos/ui";
import type { Route } from "next";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { CollectionViews } from "@/components/views/collection-views";
import { useCopy } from "@/components/work/action-ui";
import { withQuery } from "@/components/work/format";

/** New segment and the peek's editing load behind a person's action, so the collection keeps its weight. */
const CreateSegmentDialog = dynamic(() =>
  import("./segment-peek").then((m) => m.CreateSegmentDialog),
);

/**
 * Show > Segment library (B3, G-73, ADR 0142): reusable segments as a collection. A row opens its peek
 * (segment-peek.tsx), which reads the segment and edits and publishes it.
 */
export function SegmentCollection({
  org,
  title,
  segments,
  views,
  view,
  canEdit,
  creating,
  peek,
}: {
  org: string;
  title: string;
  segments: readonly LibrarySegment[];
  views: readonly string[];
  view: string;
  canEdit: boolean;
  creating: boolean;
  peek: ReactNode;
}) {
  const t = useCopy("show");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const open = (id: string) =>
    router.push(withQuery(pathname, params, { peek: id, create: null }) as Route, {
      scroll: false,
    });
  const header = (
    <PageHeader
      title={title}
      count={segments.length}
      views={
        views.length > 1 ? (
          <CollectionViews
            label={t("segmentLibrary.views")}
            value={view}
            options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            onChange={(v) => go({ view: v })}
          />
        ) : undefined
      }
      actions={
        canEdit ? (
          <Button variant="primary" icon="Plus" onClick={() => go({ create: "1" })}>
            {t("segmentLibrary.new")}
          </Button>
        ) : undefined
      }
    />
  );
  const summary = (s: LibrarySegment) => t("segmentLibrary.cueCount", { count: s.cueCount });
  let body: ReactNode;
  if (segments.length === 0) {
    body = (
      <EmptyState
        icon="Layers"
        sentence={canEdit ? t("segmentLibrary.empty") : t("segmentLibrary.emptyReadOnly")}
        actionLabel={canEdit ? t("segmentLibrary.new") : t("segmentLibrary.openRuns")}
        // The page header already holds New segment, so a screen keeps one primary action.
        {...(canEdit ? { actionVariant: "secondary" as const } : {})}
        onAction={() =>
          canEdit ? go({ create: "1" }) : router.push(`/${org}/show/run-of-show` as Route)
        }
      />
    );
  } else if (view === "table") {
    body = (
      <DataTable
        caption={t("segmentLibrary.label")}
        columns={[
          { key: "name", label: t("segmentLibrary.columns.name"), wrap: true },
          { key: "cues", label: t("segmentLibrary.columns.cues") },
          { key: "version", label: t("segmentLibrary.columns.version") },
        ]}
        rows={segments.map((s) => ({
          id: s.id,
          name: s.name,
          cues: summary(s),
          version: String(s.version),
        }))}
        onRowActivate={(row) => open(String(row["id"]))}
      />
    );
  } else {
    body = (
      <RecordList label={t("segmentLibrary.label")}>
        {segments.map((s) => (
          <RecordRow
            key={s.id}
            state="ready"
            stateLabel={summary(s)}
            recordKey={t("segmentLibrary.version", { version: s.version })}
            title={s.name}
            chips={
              s.colorKey ? (
                <Tag swatch={s.colorKey}>{t(`colors.${s.colorKey}`)}</Tag>
              ) : (
                <Tag>{summary(s)}</Tag>
              )
            }
            actionLabel={t("segmentLibrary.open")}
            onAction={() => open(s.id)}
            onOpen={() => open(s.id)}
          />
        ))}
      </RecordList>
    );
  }
  return (
    <TemplateCollection header={header} peek={peek}>
      {body}
      {creating && canEdit ? (
        <CreateSegmentDialog org={org} onClose={() => go({ create: null })} onSaved={open} />
      ) : null}
    </TemplateCollection>
  );
}
