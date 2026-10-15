"use client";

import type { PunchItem } from "@xos/data/work-orders";
import type { PersonRef, ProjectRef, RecordStateInfo } from "@xos/data/work";
import {
  Board,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Input,
  PageHeader,
  RecordList,
  RecordRow,
  SegmentedControl,
  Select,
  Tag,
  TemplateCollection,
} from "@xos/ui";
import type { Route } from "next";
import { useLocale } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ActionErrorAlert, useAction, useCopy } from "./action-ui";
import { formatWhen, fromLocalInput, stateToken, withQuery } from "./format";
import { createPunchItemAction } from "./work-order-actions";

/**
 * Work > Punch lists (Section 4.5.5): punch items, each a Task record of subtype Execute titled
 * "Correct ...", as a list, table or board by record state. Opening one shows its record peek,
 * where it is moved to Complete to close it.
 */
export function PunchCollection({
  org,
  title,
  items,
  total,
  views,
  view,
  states,
  state,
  projects,
  people,
  canCreate,
  open,
  peek,
}: {
  org: string;
  title: string;
  items: readonly PunchItem[];
  total: number;
  views: readonly string[];
  view: string;
  states: readonly RecordStateInfo[];
  state: string;
  projects: readonly ProjectRef[];
  people: readonly PersonRef[];
  canCreate: boolean;
  open: boolean;
  peek: ReactNode;
}) {
  const t = useCopy("work");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const openItem = (key: string) =>
    router.push(withQuery(pathname, params, { peek: key }) as Route, { scroll: false });
  const where = (i: PunchItem) => i.zoneName ?? i.locationText ?? t("punch.noLocation");
  const due = (i: PunchItem) =>
    formatWhen(i.record.dueAt, locale, i.record.timeZone ?? i.record.projectTimeZone);

  const header = (
    <PageHeader
      title={title}
      count={items.length}
      views={
        views.length > 1 ? (
          <SegmentedControl
            label={t("collection.views")}
            value={view}
            options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            onChange={(v) => go({ view: v })}
          />
        ) : undefined
      }
      actions={
        canCreate ? (
          <CreatePunchItem org={org} projects={projects} people={people} open={open} />
        ) : undefined
      }
    />
  );
  const filters = (
    <Select
      key={`state-${state}`}
      id="punch-state"
      label={t("collection.state")}
      value={state}
      options={[
        { value: "", label: t("collection.allStates") },
        ...states.map((s) => ({ value: s.state, label: t(`states.${s.state}`) })),
      ]}
      onChange={(e) => go({ state: e.target.value || null })}
    />
  );

  let body: ReactNode;
  if (total === 0) {
    body = (
      <EmptyState
        icon="ListChecks"
        sentence={t("empty.punchLists.sentence")}
        actionLabel={canCreate ? t("empty.punchLists.action") : t("empty.readOnlyAction")}
        onAction={() => (canCreate ? go({ create: "1" }) : router.push(`/${org}/my-work` as Route))}
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        icon="SearchX"
        sentence={t("empty.filtered")}
        actionLabel={t("collection.clear")}
        onAction={() => go({ state: null })}
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
          { key: "location", label: t("columns.location") },
          { key: "owner", label: t("columns.owner") },
          { key: "due", label: t("columns.due") },
        ]}
        rows={items.map((i) => ({
          id: i.record.key,
          key: i.record.key,
          title: i.record.title,
          state: { state: stateToken(i.record.state), label: t(`states.${i.record.state}`) },
          location: where(i),
          owner: i.record.ownerName ?? t("values.unassigned"),
          due: due(i) ?? t("values.noDate"),
        }))}
        onRowActivate={(row) => openItem(String(row["key"]))}
      />
    );
  } else if (view === "board") {
    body = (
      <section aria-label={t("collection.stateBoard")}>
        <Board
          readOnly
          columns={states.map((s) => ({
            state: stateToken(s.state),
            label: t(`states.${s.state}`),
            cards: items
              .filter((i) => i.record.state === s.state)
              .map((i) => ({
                key: i.record.key,
                title: i.record.title,
                meta: where(i),
                ...(i.record.ownerName ? { owner: i.record.ownerName } : {}),
                ...(due(i) ? { due: due(i) as string } : {}),
              })),
          }))}
          onOpen={openItem}
        />
      </section>
    );
  } else {
    body = (
      <RecordList label={title}>
        {items.map((i) => (
          <RecordRow
            key={i.id}
            state={stateToken(i.record.state)}
            stateLabel={t(`states.${i.record.state}`)}
            recordKey={i.record.key}
            kind="Task"
            title={i.record.title}
            chips={<Tag>{where(i)}</Tag>}
            {...(due(i) ? { next: due(i) as string } : {})}
            {...(i.record.ownerName ? { owner: i.record.ownerName } : {})}
            actionLabel={t("collection.open")}
            onAction={() => openItem(i.record.key)}
            onOpen={() => openItem(i.record.key)}
          />
        ))}
      </RecordList>
    );
  }

  return (
    <TemplateCollection header={header} filters={filters} peek={peek}>
      {body}
    </TemplateCollection>
  );
}

function CreatePunchItem({
  org,
  projects,
  people,
  open,
}: {
  org: string;
  projects: readonly ProjectRef[];
  people: readonly PersonRef[];
  open: boolean;
}) {
  const t = useCopy("work");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { pending, error, run, clear } = useAction();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [what, setWhat] = useState("");
  const [location, setLocation] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const tz = projects.find((p) => p.id === projectId)?.timeZone ?? "UTC";
  const setOpen = (value: boolean) => {
    clear();
    router.replace(withQuery(pathname, params, { create: value ? "1" : null }) as Route, {
      scroll: false,
    });
  };
  if (projects.length === 0) {
    return (
      <Button
        variant="primary"
        icon="FolderPlus"
        onClick={() => router.push(`/${org}/projects/all?create=1` as Route)}
      >
        {t("create.needProject")}
      </Button>
    );
  }
  return (
    <>
      <Button variant="primary" icon="Plus" onClick={() => setOpen(true)}>
        {t("punch.new")}
      </Button>
      {open ? (
        <Drawer
          title={t("punch.new")}
          open
          onOpenChange={(v) => (v ? undefined : setOpen(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("actions.cancel")}
              </Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={what.trim() === ""}
                onClick={() =>
                  run(
                    () =>
                      createPunchItemAction(org, {
                        projectId,
                        what,
                        locationText: location.trim() || null,
                        ownerId: owner || null,
                        dueAt: fromLocalInput(due, tz),
                      }),
                    () => {
                      setWhat("");
                      setOpen(false);
                    },
                  )
                }
              >
                {t("punch.create")}
              </Button>
            </>
          }
        >
          <ActionErrorAlert error={error} />
          {projects.length > 1 ? (
            <Select
              id="punch-project"
              label={t("fields.project")}
              value={projectId}
              options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
              onChange={(e) => setProjectId(e.target.value)}
            />
          ) : null}
          <Input
            id="punch-what"
            label={t("punch.what")}
            help={t("punch.whatHelp")}
            width="100%"
            value={what}
            onChange={(e) => setWhat(e.target.value)}
          />
          <Input
            id="punch-location"
            label={t("punch.location")}
            width="100%"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <Select
            id="punch-owner"
            label={t("fields.owner")}
            value={owner}
            options={[
              { value: "", label: t("values.unassigned") },
              ...people.map((p) => ({ value: p.personId, label: p.name ?? t("values.unnamed") })),
            ]}
            onChange={(e) => setOwner(e.target.value)}
          />
          <Input
            id="punch-due"
            type="datetime-local"
            label={t("fields.due")}
            help={t("fields.zoneNote", { zone: tz })}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </Drawer>
      ) : null}
    </>
  );
}
