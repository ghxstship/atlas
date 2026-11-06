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
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  IconButton,
  InlineAlert,
  Input,
  MultiSelect,
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
import { CueFormTabs } from "./cue-form-tabs";
import {
  publishLibrarySegmentAction,
  removeLibraryCueAction,
  removeLibrarySegmentAction,
  saveLibraryCueAction,
  saveLibrarySegmentAction,
} from "./depth-actions";

/**
 * Show > Segment library (B3, G-73, ADR 0142): reusable segments as a collection, and the peek that reads one. The peek
 * holds no inline fields: each change opens its own dialog, so the peek and every dialog show at most seven fields. A
 * segment is copied into running orders from their peek (Insert segment); when the library copy changes, Publish to
 * shows replaces the uncalled copies in the running orders chosen, local edits included, and the peek lists what
 * happened in each.
 */

/** Publishing takes at most this many running orders in one go (segment_publish_runs, 2921). */
const MAX_PUBLISH_RUNS = 50;

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
  const submit = () =>
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
  return (
    <form
      className="flex flex-col gap-8"
      action={submit}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
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

/** A library cue in its own dialog, in the cue tabs: label and length, words, department calls. */
function LibraryCueDialog({
  org,
  segmentId,
  cue,
  onClose,
  onSaved,
}: {
  org: string;
  segmentId: string;
  cue: LibraryCue | null;
  onClose: () => void;
  onSaved: () => void;
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
  const title = cue ? t("cues.editing", { label: cue.label }) : t("segmentLibrary.addCue");
  return (
    <Dialog title={title} open onOpenChange={(v) => (v ? undefined : onClose())} actions={null}>
      <CueFormTabs
        label={title}
        alert={<ActionErrorAlert error={save.error} />}
        saving={save.pending}
        canSave={label.trim() !== ""}
        saveVariant="primary"
        saveLabel={cue ? t("cues.save") : t("segmentLibrary.addCue")}
        cancelLabel={t("cues.cancel")}
        onCancel={onClose}
        submit={() =>
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
            onSaved,
          )
        }
        cue={
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
        }
        words={
          <>
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
          </>
        }
        calls={
          <div className="grid grid-cols-2 gap-8 max-sm:grid-cols-1">
            {CUE_CALL_KINDS.map((k) => (
              <Textarea
                key={k}
                id={`library-cue-call-${CUE_CALL_SLUGS[k]}-${key}`}
                label={t("cues.callFor", {
                  department: t(`cues.departments.${CUE_CALL_SLUGS[k]}`),
                })}
                rows={2}
                maxLength={2000}
                value={calls[k]}
                onChange={(e) => setCalls((v) => ({ ...v, [k]: e.target.value }))}
              />
            ))}
          </div>
        }
      />
    </Dialog>
  );
}

/** One running order per copy, earliest show first. */
function runsOf(copies: readonly SegmentCopy[]): SegmentCopy[] {
  return [...new Map(copies.map((c) => [c.runOfShowId, c])).values()].sort((a, b) =>
    a.showDate.localeCompare(b.showDate),
  );
}

/**
 * Publish to shows: one list of the running orders holding a copy, preselected to the outdated ones, and the warning.
 * It mounts when opened, so the preselection is worked out from the copies as they are now, and the outcome goes back
 * to the peek, since a confirmation inside a dialog that closes is never seen.
 */
function PublishDialog({
  org,
  segment,
  copies,
  onClose,
  onPublished,
}: {
  org: string;
  segment: LibrarySegmentDetail;
  copies: readonly SegmentCopy[];
  onClose: () => void;
  onPublished: (results: readonly PublishResult[]) => void;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const publish = useAction();
  const runs = runsOf(copies);
  const outdated = runsOf(copies.filter((c) => c.libraryVersion < segment.version));
  const [chosen, setChosen] = useState<readonly string[]>(() =>
    outdated.slice(0, MAX_PUBLISH_RUNS).map((c) => c.runOfShowId),
  );
  const overLimit = chosen.length > MAX_PUBLISH_RUNS;
  return (
    <Dialog
      title={t("segmentLibrary.publishTitle")}
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cues.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={publish.pending}
            disabled={chosen.length === 0 || overLimit}
            onClick={() =>
              publish.run(() => publishLibrarySegmentAction(org, segment.id, chosen), onPublished)
            }
          >
            {t("segmentLibrary.publish", { version: segment.version })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-8">
        <ActionErrorAlert error={publish.error} />
        <InlineAlert tone="warning">{t("segmentLibrary.publishWarning")}</InlineAlert>
        <MultiSelect
          id={`publish-runs-${segment.id}`}
          label={t("segmentLibrary.publishRuns")}
          value={[...chosen]}
          options={runs.map((c) => ({
            value: c.runOfShowId,
            label: t("segmentLibrary.copyOption", {
              name: c.runName,
              date: formatDay(c.showDate, locale),
              version: c.libraryVersion,
            }),
          }))}
          onChange={setChosen}
        />
        {outdated.length > MAX_PUBLISH_RUNS ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("segmentLibrary.publishMore", {
              count: outdated.length - MAX_PUBLISH_RUNS,
              limit: MAX_PUBLISH_RUNS,
            })}
          </p>
        ) : null}
        {overLimit ? (
          <InlineAlert tone="warning">
            {t("segmentLibrary.publishOverLimit", { limit: MAX_PUBLISH_RUNS })}
          </InlineAlert>
        ) : null}
      </div>
    </Dialog>
  );
}

/** What one publish did in one running order, with the name as it read when published. */
interface PublishOutcome extends PublishResult {
  readonly name: string;
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
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const action = useAction();
  const [dialog, setDialog] = useState<"segment" | "publish" | "delete" | "addCue" | null>(null);
  const [editing, setEditing] = useState<LibraryCue | null>(null);
  const [outcomes, setOutcomes] = useState<readonly PublishOutcome[] | null>(null);
  const close = () =>
    router.replace(withQuery(pathname, params, { peek: null }) as Route, { scroll: false });
  const duration = (s: number | null) =>
    s === null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const runs = runsOf(copies);
  const outdated = copies.some((c) => c.libraryVersion < segment.version);
  const saved = () => {
    setDialog(null);
    setEditing(null);
    router.refresh();
  };
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
          <div className="flex flex-wrap items-center gap-8">
            {runs.length > 0 && segment.cues.length > 0 ? (
              <Button variant="primary" icon="Send" onClick={() => setDialog("publish")}>
                {t("segmentLibrary.publishOpen")}
              </Button>
            ) : null}
            <Button variant="secondary" icon="Pencil" onClick={() => setDialog("segment")}>
              {t("segmentLibrary.editSegment")}
            </Button>
            <Button variant="secondary" icon="Plus" onClick={() => setDialog("addCue")}>
              {t("segmentLibrary.addCue")}
            </Button>
            <Button variant="ghost" icon="Trash2" onClick={() => setDialog("delete")}>
              {t("segmentLibrary.delete")}
            </Button>
          </div>
        ) : null}
        {canEdit && outdated && segment.cues.length > 0 ? (
          <InlineAlert tone="info">{t("segmentLibrary.libraryUpdated")}</InlineAlert>
        ) : null}
        {outcomes ? (
          <ul
            role="status"
            aria-label={t("segmentLibrary.outcomesLabel")}
            className="m-0 flex list-none flex-col gap-4 p-0"
          >
            {outcomes.map((r, i) => (
              <li key={`${r.runOfShowId}:${r.instanceId ?? i}`} className="text-text-13">
                {t("segmentLibrary.outcomeLine", {
                  name: r.name,
                  outcome: t(`segmentLibrary.outcomes.${r.outcome.replace(" ", "")}`),
                })}
              </li>
            ))}
          </ul>
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
              {segment.cues.map((c) => (
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
                        onClick={() => setEditing(c)}
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
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby={`library-copies-${segment.id}`} className="flex flex-col gap-8">
          <h3 id={`library-copies-${segment.id}`} className="m-0 text-label-13 font-semibold">
            {t("segmentLibrary.copiesTitle")}
          </h3>
          {runs.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("segmentLibrary.noCopies")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {runs.map((c) => (
                <li key={c.runOfShowId} className="text-text-13">
                  {t("segmentLibrary.copyOption", {
                    name: c.runName,
                    date: formatDay(c.showDate, locale),
                    version: c.libraryVersion,
                  })}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {dialog === "segment" ? (
        <Dialog
          title={t("segmentLibrary.editSegment")}
          open
          onOpenChange={(v) => (v ? undefined : setDialog(null))}
          actions={
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t("cues.cancel")}
            </Button>
          }
        >
          <SegmentForm org={org} segment={segment} onSaved={saved} />
        </Dialog>
      ) : null}
      {dialog === "addCue" ? (
        <LibraryCueDialog
          org={org}
          segmentId={segment.id}
          cue={null}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      ) : null}
      {editing ? (
        <LibraryCueDialog
          key={editing.id}
          org={org}
          segmentId={segment.id}
          cue={editing}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      ) : null}
      {dialog === "publish" ? (
        <PublishDialog
          org={org}
          segment={segment}
          copies={copies}
          onClose={() => setDialog(null)}
          onPublished={(results) => {
            // Named now: a refresh changes the copies, and a replaced or removed copy may leave the list.
            setOutcomes(
              results.map((r) => ({
                ...r,
                name: runs.find((c) => c.runOfShowId === r.runOfShowId)?.runName ?? "",
              })),
            );
            saved();
          }}
        />
      ) : null}
      {dialog === "delete" ? (
        <Dialog
          title={t("segmentLibrary.deleteTitle", { name: segment.name })}
          description={t("segmentLibrary.deleteBody")}
          open
          onOpenChange={(v) => (v ? undefined : setDialog(null))}
          actions={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {t("cues.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => action.run(() => removeLibrarySegmentAction(org, segment.id), close)}
              >
                {t("segmentLibrary.deleteConfirm")}
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      ) : null}
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
