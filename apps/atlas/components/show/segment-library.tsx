"use client";

import type {
  LibraryCue,
  LibrarySegment,
  LibrarySegmentDetail,
  PublishResult,
  SegmentCopy,
} from "@xos/data/segment-library";
import { CUE_CALL_KINDS, CUE_CALL_SLUGS, SEGMENT_COLORS, type CueCallKind } from "@xos/data/show";
import {
  Button,
  Checkbox,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  IconButton,
  InlineAlert,
  Input,
  PageHeader,
  RecordList,
  RecordRow,
  Select,
  Tag,
  TemplateCollection,
  Textarea,
} from "@xos/ui";
import type { Route } from "next";
import { useLocale } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CollectionViews } from "@/components/views/collection-views";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import { formatDay, withQuery } from "@/components/work/format";
import {
  publishLibrarySegmentAction,
  removeLibraryCueAction,
  removeLibrarySegmentAction,
  saveLibraryCueAction,
  saveLibrarySegmentAction,
} from "./depth-actions";

/**
 * Show > Segment library (B3, G-73, ADR 0142): reusable segments as a collection, and the peek that edits one. A
 * segment is copied into running orders from their peek (Insert segment); when the library copy changes, Publish to
 * shows replaces the uncalled copies in the running orders chosen here, local edits included, and lists what
 * happened in each.
 */

function SegmentForm({
  org,
  segment,
  onSaved,
}: {
  org: string;
  segment: LibrarySegment | null;
  onSaved: (id: string) => void;
}) {
  const t = useCopy("show");
  const save = useAction();
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [color, setColor] = useState<string>(segment?.colorKey ?? "");
  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        save.run(
          () =>
            saveLibrarySegmentAction(org, {
              ...(segment ? { id: segment.id } : {}),
              name,
              description,
              colorKey: color === "" ? null : color,
            }),
          (data) => onSaved(data.id),
        );
      }}
    >
      <ActionErrorAlert error={save.error} />
      <Input
        id={`segment-name-${segment?.id ?? "new"}`}
        label={t("segmentLibrary.name")}
        placeholder={t("segmentLibrary.nameExample")}
        maxLength={200}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Select
        id={`segment-color-${segment?.id ?? "new"}`}
        label={t("segmentLibrary.color")}
        value={color}
        options={[
          { value: "", label: t("colors.none") },
          ...SEGMENT_COLORS.map((c) => ({ value: c, label: t(`colors.${c}`) })),
        ]}
        onChange={(e) => setColor(e.target.value)}
      />
      <Textarea
        id={`segment-description-${segment?.id ?? "new"}`}
        label={t("segmentLibrary.description")}
        rows={2}
        maxLength={2000}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div>
        <Button
          type="submit"
          variant="primary"
          loading={save.pending}
          disabled={name.trim() === ""}
        >
          {t("segmentLibrary.save")}
        </Button>
      </div>
    </form>
  );
}

function LibraryCueForm({
  org,
  segmentId,
  cue,
  onDone,
}: {
  org: string;
  segmentId: string;
  cue: LibraryCue | null;
  onDone: () => void;
}) {
  const t = useCopy("show");
  const save = useAction();
  const [label, setLabel] = useState(cue?.label ?? "");
  const [duration, setDuration] = useState(
    cue === null || cue.durationSeconds === null ? "" : String(cue.durationSeconds),
  );
  const [description, setDescription] = useState(cue?.description ?? "");
  const [script, setScript] = useState(cue?.script ?? "");
  const [calls, setCalls] = useState(
    Object.fromEntries(
      CUE_CALL_KINDS.map((k) => [k, cue?.calls.find((c) => c.kind === k)?.instruction ?? ""]),
    ) as Record<CueCallKind, string>,
  );
  const key = cue?.id ?? `new-${segmentId}`;
  return (
    <form
      aria-label={cue ? t("cues.editing", { label: cue.label }) : t("segmentLibrary.addCue")}
      className="flex w-full flex-col gap-8 py-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.run(
          () =>
            saveLibraryCueAction(org, {
              segmentId,
              ...(cue ? { id: cue.id } : {}),
              label,
              durationSeconds: duration === "" ? null : Number(duration),
              description,
              script,
              calls,
            }),
          () => {
            if (!cue) {
              setLabel("");
              setDuration("");
              setDescription("");
              setScript("");
            }
            onDone();
          },
        );
      }}
    >
      <ActionErrorAlert error={save.error} />
      <div className="flex flex-wrap items-end gap-8">
        <Input
          id={`library-cue-label-${key}`}
          label={t("cues.label")}
          maxLength={200}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          id={`library-cue-duration-${key}`}
          type="number"
          min={0}
          max={86400}
          width={120}
          label={t("cues.duration")}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
      </div>
      <Textarea
        id={`library-cue-description-${key}`}
        label={t("cues.description")}
        rows={2}
        maxLength={2000}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Textarea
        id={`library-cue-script-${key}`}
        label={t("cues.script")}
        rows={3}
        maxLength={20000}
        value={script}
        onChange={(e) => setScript(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-8 max-sm:grid-cols-1">
        {CUE_CALL_KINDS.map((k) => (
          <Textarea
            key={k}
            id={`library-cue-call-${CUE_CALL_SLUGS[k]}-${key}`}
            label={t("cues.callFor", { department: t(`cues.departments.${CUE_CALL_SLUGS[k]}`) })}
            rows={2}
            maxLength={2000}
            value={calls[k]}
            onChange={(e) => setCalls((v) => ({ ...v, [k]: e.target.value }))}
          />
        ))}
      </div>
      <div>
        <Button
          type="submit"
          variant={cue ? "primary" : "secondary"}
          loading={save.pending}
          disabled={label.trim() === ""}
        >
          {cue ? t("cues.save") : t("segmentLibrary.addCue")}
        </Button>
      </div>
    </form>
  );
}

/** Publish to shows: the running orders holding a copy, the GEM warning, and what happened in each. */
function PublishSection({
  org,
  segment,
  copies,
}: {
  org: string;
  segment: LibrarySegmentDetail;
  copies: readonly SegmentCopy[];
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const publish = useAction();
  const outdated = copies.filter((c) => c.libraryVersion < segment.version);
  const [chosen, setChosen] = useState<readonly string[]>(() => [
    ...new Set(outdated.map((c) => c.runOfShowId)),
  ]);
  const [results, setResults] = useState<readonly PublishResult[] | null>(null);
  const runs = [...new Map(copies.map((c) => [c.runOfShowId, c])).values()];
  return (
    <section aria-labelledby={`publish-${segment.id}`} className="flex flex-col gap-8">
      <h3 id={`publish-${segment.id}`} className="m-0 text-label-13 font-semibold">
        {t("segmentLibrary.publishTitle")}
      </h3>
      {outdated.length > 0 ? (
        <InlineAlert tone="info">{t("segmentLibrary.libraryUpdated")}</InlineAlert>
      ) : null}
      {runs.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("segmentLibrary.noCopies")}</p>
      ) : (
        <>
          <InlineAlert tone="warning">{t("segmentLibrary.publishWarning")}</InlineAlert>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {runs.map((c) => (
              <li key={c.runOfShowId}>
                <Checkbox
                  label={t("segmentLibrary.copyOption", {
                    name: c.runName,
                    date: formatDay(c.showDate, locale),
                    version: c.libraryVersion,
                  })}
                  checked={chosen.includes(c.runOfShowId)}
                  onChange={(e) =>
                    setChosen((v) =>
                      e.target.checked
                        ? [...v, c.runOfShowId]
                        : v.filter((id) => id !== c.runOfShowId),
                    )
                  }
                />
              </li>
            ))}
          </ul>
          <ActionErrorAlert error={publish.error} />
          <div>
            <Button
              variant="primary"
              loading={publish.pending}
              disabled={chosen.length === 0}
              onClick={() =>
                publish.run(
                  () => publishLibrarySegmentAction(org, segment.id, chosen),
                  (data) => setResults(data),
                )
              }
            >
              {t("segmentLibrary.publish", { version: segment.version })}
            </Button>
          </div>
        </>
      )}
      {results ? (
        <ul
          role="status"
          aria-label={t("segmentLibrary.outcomesLabel")}
          className="m-0 flex list-none flex-col gap-4 p-0"
        >
          {results.map((r, i) => (
            <li key={`${r.runOfShowId}:${r.instanceId ?? i}`} className="text-text-13">
              {t("segmentLibrary.outcomeLine", {
                name: runs.find((c) => c.runOfShowId === r.runOfShowId)?.runName ?? "",
                outcome: t(`segmentLibrary.outcomes.${r.outcome.replace(" ", "")}`),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The peek of one library segment. */
export function SegmentPeek({
  org,
  segment,
  copies,
  canEdit,
}: {
  org: string;
  segment: LibrarySegmentDetail;
  copies: readonly SegmentCopy[];
  canEdit: boolean;
}) {
  const t = useCopy("show");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const action = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const close = () =>
    router.replace(withQuery(pathname, params, { peek: null }) as Route, { scroll: false });
  const duration = (s: number | null) =>
    s === null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return (
    <Drawer
      title={segment.name}
      open
      shortcutScope="record"
      onOpenChange={(v) => (v ? undefined : close())}
    >
      <div className="flex flex-col gap-24">
        <div className="flex flex-wrap items-center gap-8">
          {segment.colorKey ? (
            <Tag swatch={segment.colorKey}>{t(`colors.${segment.colorKey}`)}</Tag>
          ) : null}
          <Tag>{t("segmentLibrary.version", { version: segment.version })}</Tag>
          <Tag>{t("segmentLibrary.cueCount", { count: segment.cues.length })}</Tag>
        </div>
        {segment.description ? <p className="m-0 text-text-14">{segment.description}</p> : null}
        {canEdit ? (
          <SegmentForm org={org} segment={segment} onSaved={() => router.refresh()} />
        ) : null}

        <section aria-labelledby={`library-cues-${segment.id}`} className="flex flex-col gap-8">
          <h3 id={`library-cues-${segment.id}`} className="m-0 text-label-13 font-semibold">
            {t("cues.title")}
          </h3>
          <ActionErrorAlert error={action.error} />
          {segment.cues.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("segmentLibrary.noCues")}</p>
          ) : (
            <ol className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {segment.cues.map((c) =>
                editing === c.id ? (
                  <li key={c.id} className="flex">
                    <LibraryCueForm
                      org={org}
                      segmentId={segment.id}
                      cue={c}
                      onDone={() => {
                        setEditing(null);
                        router.refresh();
                      }}
                    />
                  </li>
                ) : (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-8 py-6">
                    <span className="flex flex-col gap-2">
                      <span className="flex items-baseline gap-8">
                        <span className="font-mono text-text-12 text-text-secondary">
                          {c.position}
                        </span>
                        <span className="text-text-14">{c.label}</span>
                        <span className="text-text-12 text-text-secondary">
                          {duration(c.durationSeconds)}
                        </span>
                      </span>
                      {c.calls.map((k) => (
                        <span key={k.kind} className="text-text-12 text-text-secondary">
                          {t("cues.callLine", {
                            department: t(`cues.departments.${CUE_CALL_SLUGS[k.kind]}`),
                            instruction: k.instruction,
                          })}
                        </span>
                      ))}
                    </span>
                    {canEdit ? (
                      <span className="flex items-center gap-4">
                        <IconButton
                          icon="Pencil"
                          label={t("cues.edit", { label: c.label })}
                          onClick={() => setEditing(c.id)}
                        />
                        <IconButton
                          icon="X"
                          label={t("cues.remove", { label: c.label })}
                          onClick={() =>
                            action.run(
                              () => removeLibraryCueAction(org, c.id),
                              () => router.refresh(),
                            )
                          }
                        />
                      </span>
                    ) : null}
                  </li>
                ),
              )}
            </ol>
          )}
          {canEdit ? (
            <LibraryCueForm
              org={org}
              segmentId={segment.id}
              cue={null}
              onDone={() => router.refresh()}
            />
          ) : null}
        </section>

        {canEdit ? <PublishSection org={org} segment={segment} copies={copies} /> : null}

        {canEdit ? (
          <div>
            <Button variant="ghost" icon="Trash2" onClick={() => setConfirmDelete(true)}>
              {t("segmentLibrary.delete")}
            </Button>
            {confirmDelete ? (
              <Dialog
                title={t("segmentLibrary.deleteTitle", { name: segment.name })}
                description={t("segmentLibrary.deleteBody")}
                open
                onOpenChange={(v) => (v ? undefined : setConfirmDelete(false))}
                actions={
                  <>
                    <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                      {t("cues.cancel")}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() =>
                        action.run(() => removeLibrarySegmentAction(org, segment.id), close)
                      }
                    >
                      {t("segmentLibrary.deleteConfirm")}
                    </Button>
                  </>
                }
              >
                {null}
              </Dialog>
            ) : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}

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
        <Dialog
          title={t("segmentLibrary.new")}
          description={t("segmentLibrary.newBody")}
          open
          onOpenChange={(v) => (v ? undefined : go({ create: null }))}
          actions={
            <Button variant="ghost" onClick={() => go({ create: null })}>
              {t("cues.cancel")}
            </Button>
          }
        >
          <SegmentForm org={org} segment={null} onSaved={(id) => open(id)} />
        </Dialog>
      ) : null}
    </TemplateCollection>
  );
}
