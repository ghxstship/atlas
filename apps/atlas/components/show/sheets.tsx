"use client";

import type { Call, CallSheet, DaySheet } from "@xos/data/show";
import type { ProjectRef } from "@xos/data/work";
import {
  Button,
  Calendar,
  DataTable,
  Drawer,
  EmptyState,
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
import { useCallback, useState, type ReactNode } from "react";
import { DraftEntry } from "@/components/aurora/entry/draft-entry";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { undoStack, type UndoResult } from "@/components/undo/undo-stack";
import type { ActionResult } from "@/components/work/action-result";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import { formatDay, formatScheduleTime, formatWhen, withQuery } from "@/components/work/format";
import { useScheduleView } from "@/components/work/use-schedule-view";
import { shiftMonth } from "@/components/work/record-collection";
import {
  createCallSheetAction,
  deleteSheetAction,
  publishSheetAction,
  restoreSheetAction,
  saveDaySheetAction,
} from "./actions";
import { CollectionViews } from "@/components/views/collection-views";

type Sheet = (DaySheet | CallSheet) & { readonly id: string };
type Kind = "daySheets" | "callSheets";

const TABLE: Readonly<Record<Kind, "day_sheets" | "call_sheets">> = {
  daySheets: "day_sheets",
  callSheets: "call_sheets",
};

/**
 * Puts a sheet's move to Trash on the session's undo stack (Section 11.7): the shell's Undo toast
 * shows for 8 seconds, outliving the peek that closes, and its Undo or Cmd or Ctrl+Z restores the
 * sheet; redo moves it to Trash again. A sheet saved for the same day since is refused as a conflict.
 */
function useSheetTrash(org: string, kind: Kind) {
  const t = useCopy("show");
  const tw = useCopy("work");
  const locale = useLocale();
  return useCallback(
    (sheet: Pick<Sheet, "id" | "projectKey" | "day">) => {
      const asUndo = async (action: () => Promise<ActionResult>): Promise<UndoResult> => {
        const result = await action();
        return result.ok ? { ok: true } : { ok: false, message: tw(`errors.${result.error.key}`) };
      };
      undoStack.push({
        label: t(`${kind}.trashed`, {
          project: sheet.projectKey,
          day: formatDay(sheet.day, locale, { dateStyle: "medium" }),
        }),
        undo: () => asUndo(() => restoreSheetAction(org, TABLE[kind], sheet.id)),
        redo: () => asUndo(() => deleteSheetAction(org, TABLE[kind], sheet.id)),
      });
    },
    [org, kind, t, tw, locale],
  );
}

/**
 * Show > Day sheets and Call sheets (Section 4.5.5): one sheet per project day, as a list, a table
 * or a month calendar. Day sheets carry the day's plan; call sheets derive their calls from the
 * day's crew shifts. Publishing needs show.call_sheet.publish and happens once. A table row's menu
 * (right-click, Shift+F10 or the Context Menu key) opens the sheet or moves it to Trash.
 */
export function SheetCollection({
  org,
  kind,
  title,
  sheets,
  views,
  view,
  month,
  today,
  projects,
  canWrite,
  open,
  openId,
  peek,
}: {
  org: string;
  kind: Kind;
  title: string;
  sheets: readonly Sheet[];
  views: readonly string[];
  view: string;
  month: string;
  today: string;
  projects: readonly ProjectRef[];
  canWrite: boolean;
  open: boolean;
  /** The sheet the peek shows, which closes when that sheet moves to Trash from its row. */
  openId?: string;
  peek: ReactNode;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const rowMenu = useRowMenu();
  const removal = useAction();
  const trashed = useSheetTrash(org, kind);
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const openSheet = (id: string) =>
    router.push(withQuery(pathname, params, { peek: id }) as Route, { scroll: false });
  const status = (s: Sheet) =>
    s.publishedAt
      ? t(`${kind}.published`, {
          time: formatWhen(s.publishedAt, locale, "UTC", { dateStyle: "medium" }) ?? "",
        })
      : t(`${kind}.draft`);

  const header = (
    <PageHeader
      title={title}
      count={sheets.length}
      views={
        views.length > 1 ? (
          <CollectionViews
            label={t(`${kind}.views`)}
            value={view}
            options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            onChange={(v) => go({ view: v })}
          />
        ) : undefined
      }
      actions={
        canWrite ? <CreateSheet org={org} kind={kind} projects={projects} open={open} /> : undefined
      }
    />
  );

  let body: ReactNode;
  if (sheets.length === 0) {
    body = (
      <EmptyState
        icon={kind === "daySheets" ? "FileText" : "Megaphone"}
        sentence={canWrite ? t(`${kind}.empty`) : t(`${kind}.emptyReadOnly`)}
        actionLabel={canWrite ? t(`${kind}.emptyAction`) : t(`${kind}.readOnlyAction`)}
        onAction={() =>
          canWrite ? go({ create: "1" }) : router.push(`/${org}/schedule/calendar` as Route)
        }
      />
    );
  } else if (view === "calendar") {
    const byLabel = new Map<string, string>();
    const events = sheets
      .filter((s) => s.day.startsWith(month.slice(0, 7)))
      .map((s) => {
        const label = t(`${kind}.calendarLabel`, { project: s.projectKey });
        byLabel.set(`${s.day} ${label}`, s.id);
        return {
          date: s.day,
          label,
          state: s.publishedAt ? ("complete" as const) : ("proposed" as const),
        };
      });
    body = (
      <div className="flex flex-col gap-8">
        <div className="flex gap-8">
          <Button onClick={() => go({ month: shiftMonth(month, -1) })}>
            {t(`${kind}.previousMonth`)}
          </Button>
          <Button onClick={() => go({ month: shiftMonth(month, 1) })}>
            {t(`${kind}.nextMonth`)}
          </Button>
        </div>
        <Calendar
          month={month}
          today={today}
          events={events}
          onEventSelect={(e) => {
            const id = byLabel.get(`${e.date} ${e.label}`);
            if (id) openSheet(id);
          }}
        />
      </div>
    );
  } else if (view === "table") {
    body = (
      <>
        <ActionErrorAlert error={removal.error} />
        <DataTable
          caption={t(`${kind}.listLabel`)}
          columns={[
            { key: "day", label: t(`${kind}.day`), wrap: true },
            { key: "project", label: t(`${kind}.project`), type: "code" },
            { key: "status", label: t(`${kind}.status`) },
          ]}
          rows={sheets.map((s) => ({
            id: s.id,
            day: formatDay(s.day, locale, { dateStyle: "full" }),
            project: s.projectKey,
            status: status(s),
          }))}
          onRowActivate={(row) => openSheet(String(row["id"]))}
          onRowContextMenu={(_row, index, at, cell) => {
            const s = sheets[index];
            if (!s) return;
            // A sheet has no full page or property that changes in bulk: its menu opens it, and
            // moves an unpublished sheet to Trash with an 8-second Undo, as its peek does.
            rowMenu.open(
              {
                id: s.id,
                label: `${s.projectKey} · ${formatDay(s.day, locale, { dateStyle: "medium" })}`,
                open: () => openSheet(s.id),
                ...(canWrite && !s.publishedAt
                  ? {
                      more: [
                        {
                          label: t(`${kind}.delete`),
                          icon: "Trash2" as const,
                          danger: true,
                          onSelect: () =>
                            removal.run(
                              () => deleteSheetAction(org, TABLE[kind], s.id),
                              () => {
                                trashed(s);
                                if (openId === s.id) go({ peek: null });
                              },
                            ),
                        },
                      ],
                    }
                  : {}),
              },
              at,
              cell,
            );
          }}
        />
        {rowMenu.menu}
      </>
    );
  } else {
    body = (
      <RecordList label={t(`${kind}.listLabel`)}>
        {sheets.map((s) => (
          <RecordRow
            key={s.id}
            state={s.publishedAt ? "complete" : "proposed"}
            stateLabel={status(s)}
            recordKey={s.projectKey}
            title={formatDay(s.day, locale, { dateStyle: "full" })}
            chips={<Tag tone={s.publishedAt ? "success" : "neutral"}>{status(s)}</Tag>}
            actionLabel={t(kind === "daySheets" ? "daySheets.open" : "callSheets.openSheet")}
            onAction={() => openSheet(s.id)}
            onOpen={() => openSheet(s.id)}
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

function CreateSheet({
  org,
  kind,
  projects,
  open,
}: {
  org: string;
  kind: Kind;
  projects: readonly ProjectRef[];
  open: boolean;
}) {
  const t = useCopy("show");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { pending, error, run, clear } = useAction();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [day, setDay] = useState("");
  const setOpen = (value: boolean) => {
    clear();
    router.replace(withQuery(pathname, params, { create: value ? "1" : null }) as Route, {
      scroll: false,
    });
  };
  if (projects.length === 0) return null;
  return (
    <>
      <Button variant="primary" icon="Plus" onClick={() => setOpen(true)}>
        {t(`${kind}.new`)}
      </Button>
      {open ? (
        <Drawer
          title={t(`${kind}.new`)}
          open
          onOpenChange={(v) => (v ? undefined : setOpen(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t(`${kind}.cancel`)}
              </Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={day === "" || projectId === ""}
                onClick={() =>
                  run(
                    () =>
                      kind === "daySheets"
                        ? saveDaySheetAction(org, { projectId, day, body: "" })
                        : createCallSheetAction(org, { projectId, day }),
                    (data) =>
                      router.replace(
                        withQuery(pathname, params, { create: null, peek: data.id }) as Route,
                        { scroll: false },
                      ),
                  )
                }
              >
                {t(`${kind}.create`)}
              </Button>
            </>
          }
        >
          <ActionErrorAlert error={error} />
          {projects.length > 1 ? (
            <Select
              id={`${kind}-project`}
              label={t(`${kind}.project`)}
              value={projectId}
              options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
              onChange={(e) => setProjectId(e.target.value)}
            />
          ) : null}
          <Input
            id={`${kind}-day`}
            type="date"
            label={t(`${kind}.day`)}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </Drawer>
      ) : null}
    </>
  );
}

/**
 * A day sheet: its plan as text, drafted with Aurora or typed, saved, then published once. Moving
 * an unpublished sheet to Trash offers Undo for 8 seconds (Section 11.7).
 */
export function DaySheetPeek({
  org,
  sheet,
  canWrite,
  canPublish,
  dayTypes,
  children,
}: {
  org: string;
  sheet: DaySheet;
  canWrite: boolean;
  canPublish: boolean;
  /** The day's types (B4, G-38), as text-labelled tags under the title. */
  dayTypes?: ReactNode;
  children?: ReactNode;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { pending, error, run } = useAction();
  const trashed = useSheetTrash(org, "daySheets");
  const [body, setBody] = useState(sheet.body);
  const [saved, setSaved] = useState(false);
  const close = () =>
    router.replace(withQuery(pathname, params, { peek: null }) as Route, { scroll: false });
  const title = `${sheet.projectKey} · ${formatDay(sheet.day, locale, { dateStyle: "full" })}`;
  return (
    <Drawer title={title} open onOpenChange={(v) => (v ? undefined : close())}>
      {dayTypes}
      <ActionErrorAlert error={error} />
      <Tag tone={sheet.publishedAt ? "success" : "neutral"}>
        {sheet.publishedAt
          ? t("daySheets.published", { time: formatWhen(sheet.publishedAt, locale, "UTC") ?? "" })
          : t("daySheets.draft")}
      </Tag>
      {canWrite ? (
        <form
          className="flex flex-col gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(false);
            run(
              () => saveDaySheetAction(org, { projectId: sheet.projectId, day: sheet.day, body }),
              () => setSaved(true),
            );
          }}
        >
          {/* Draft with Aurora (Section 4.7, S4.7-05): fills the body; Save is the write. */}
          <DraftEntry
            kind="day_sheet"
            fields={{ body: "body" }}
            context={[
              { collection: "day-sheets", id: sheet.id, label: title },
              { collection: "projects", id: sheet.projectId, label: sheet.projectKey },
            ]}
            maxBody={20_000}
          />
          <Textarea
            id={`day-sheet-${sheet.id}`}
            name="body"
            label={t("daySheets.body")}
            help={t("daySheets.bodyHelp")}
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex items-center gap-8">
            <Button type="submit" loading={pending}>
              {t("daySheets.save")}
            </Button>
            {saved ? (
              <p role="status" className="m-0 text-text-13 text-success-text">
                {t("daySheets.saved")}
              </p>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="m-0 whitespace-pre-wrap text-text-14">{sheet.body}</p>
      )}
      <div className="flex gap-8">
        {canPublish && !sheet.publishedAt ? (
          <Button
            variant="primary"
            loading={pending}
            onClick={() => run(() => publishSheetAction(org, "day_sheets", sheet.id))}
          >
            {t("daySheets.publish")}
          </Button>
        ) : null}
        {canWrite && !sheet.publishedAt ? (
          <Button
            variant="ghost"
            icon="Trash2"
            onClick={() =>
              run(
                () => deleteSheetAction(org, "day_sheets", sheet.id),
                () => {
                  trashed(sheet);
                  close();
                },
              )
            }
          >
            {t("daySheets.delete")}
          </Button>
        ) : null}
      </div>
      {children}
    </Drawer>
  );
}

/** A call sheet: the day's calls from crew shifts, published once to the called crew. */
export function CallSheetPeek({
  org,
  sheet,
  calls,
  timeZone,
  canPublish,
  children,
}: {
  org: string;
  sheet: CallSheet;
  calls: readonly Call[];
  timeZone: string;
  canPublish: boolean;
  children?: ReactNode;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { pending, error, run } = useAction();
  const trashed = useSheetTrash(org, "callSheets");
  const close = () =>
    router.replace(withQuery(pathname, params, { peek: null }) as Route, { scroll: false });
  // Call times follow me.time_zone_display and carry their zone abbreviation (Section 15).
  const view = useScheduleView();
  const time = (at: string) => formatScheduleTime(at, locale, timeZone, view, "time") ?? "";
  return (
    <Drawer
      title={`${sheet.projectKey} · ${formatDay(sheet.day, locale, { dateStyle: "full" })}`}
      open
      onOpenChange={(v) => (v ? undefined : close())}
    >
      <ActionErrorAlert error={error} />
      <Tag tone={sheet.publishedAt ? "success" : "neutral"}>
        {sheet.publishedAt
          ? t("callSheets.published", { time: formatWhen(sheet.publishedAt, locale, "UTC") ?? "" })
          : t("callSheets.draft")}
      </Tag>
      <h3 className="m-0 text-label-13 font-semibold">{t("callSheets.calls")}</h3>
      {calls.length === 0 ? (
        <EmptyState
          icon="Users"
          sentence={t("callSheets.noCalls")}
          actionLabel={t("callSheets.openCrew")}
          onAction={() => router.push(`/${org}/crew/schedule` as Route)}
        />
      ) : (
        <DataTable
          caption={t("callSheets.callsLabel", { day: formatDay(sheet.day, locale) })}
          columns={[
            { key: "call", label: t("callSheets.columns.call") },
            { key: "until", label: t("callSheets.columns.until") },
            { key: "role", label: t("callSheets.columns.role") },
            { key: "person", label: t("callSheets.columns.person") },
          ]}
          rows={calls.map((c) => ({
            id: c.shiftId,
            call: time(c.startsAt),
            until: time(c.endsAt),
            role: c.roleTitle ? `${c.roleTitle} · ${c.roleCode}` : t("callSheets.noRole"),
            person: c.personName ?? t("callSheets.open"),
          }))}
        />
      )}
      <div className="flex gap-8">
        {canPublish && !sheet.publishedAt ? (
          <Button
            variant="primary"
            loading={pending}
            onClick={() => run(() => publishSheetAction(org, "call_sheets", sheet.id))}
          >
            {t("callSheets.publish")}
          </Button>
        ) : null}
        {canPublish && !sheet.publishedAt ? (
          <Button
            variant="ghost"
            icon="Trash2"
            onClick={() =>
              run(
                () => deleteSheetAction(org, "call_sheets", sheet.id),
                () => {
                  trashed(sheet);
                  close();
                },
              )
            }
          >
            {t("callSheets.delete")}
          </Button>
        ) : null}
      </div>
      {children}
    </Drawer>
  );
}
