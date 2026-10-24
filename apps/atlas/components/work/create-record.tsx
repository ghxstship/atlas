"use client";

import type { CanonOption, PersonRef, ProjectRef, RecordKindInfo } from "@xos/data/work";
import { Button, Drawer, Input, Select } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { ActionErrorAlert, useAction, useCopy } from "./action-ui";
import { createRecordAction } from "./actions";
import { fromLocalInput, withQuery } from "./format";
import {
  CustomFieldInputs,
  type CustomFieldInputsHandle,
} from "@/components/custom-fields/custom-field-inputs";

/** The XYZ family a new record starts with when no URID category gives one (proposed ADR, A08). */
function defaultXyz(recordClass: string | undefined, tags: readonly string[]): string {
  const wanted = recordClass === "Time" ? "Z" : "Y";
  return tags.includes(wanted) ? wanted : (tags[0] ?? "Y");
}

/**
 * New record (Section 11.10: at most seven fields before More fields; context carries forward). The
 * sheet opens from the page's primary action or `?create=1`, inherits the page's project and kind,
 * and opens the new record's peek after saving. Title grammar is checked by the database and its
 * correction is shown under the title.
 */
export function CreateRecordDialog({
  org,
  kinds,
  projects,
  people,
  phases,
  xyzTags,
  open,
  fixedKind,
  fixedProjectId,
  label,
}: {
  org: string;
  kinds: readonly RecordKindInfo[];
  projects: readonly ProjectRef[];
  people: readonly PersonRef[];
  phases: readonly (CanonOption & { gate: number })[];
  xyzTags: readonly string[];
  open: boolean;
  fixedKind?: string;
  fixedProjectId?: string;
  label?: string;
}) {
  const t = useCopy("work");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { pending, error, run, clear } = useAction();
  const firstKind = fixedKind ?? params.get("kind")?.split(",")[0] ?? "Task";
  const [kind, setKind] = useState(kinds.some((k) => k.kind === firstKind) ? firstKind : "Task");
  const [subtype, setSubtype] = useState("");
  const [title, setTitle] = useState("");
  const projectKey = params.get("project");
  const [projectId, setProjectId] = useState(
    fixedProjectId ?? projects.find((p) => p.key === projectKey)?.id ?? projects[0]?.id ?? "",
  );
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const [more, setMore] = useState(false);
  const [phase, setPhase] = useState("");
  const [urid, setUrid] = useState("");
  const info = kinds.find((k) => k.kind === kind);
  const [xyz, setXyz] = useState(defaultXyz(info?.recordClass, xyzTags));
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const project = projects.find((p) => p.id === projectId);
  const tz = project?.timeZone ?? "UTC";
  const custom = useRef<CustomFieldInputsHandle>(null);

  const setOpen = (value: boolean) => {
    clear();
    router.replace(withQuery(pathname, params, { create: value ? "1" : null }) as Route, {
      scroll: false,
    });
  };

  const submit = () =>
    custom.current?.check() !== false &&
    run(
      () =>
        createRecordAction(org, {
          projectId,
          kind,
          subtype: subtype || null,
          title,
          phaseCode: phase || null,
          urid: urid.trim() || null,
          xyz,
          ownerId: owner || null,
          startsAt: fromLocalInput(starts, tz),
          endsAt: fromLocalInput(ends, tz),
          dueAt: fromLocalInput(due, tz),
          customFields: custom.current?.inputs(),
        }),
      (data) => {
        setTitle("");
        router.replace(withQuery(pathname, params, { create: null, peek: data.key }) as Route, {
          scroll: false,
        });
      },
    );

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
        {label ?? t("create.button")}
      </Button>
      {open ? (
        <Drawer
          title={
            fixedKind ? t("create.titleKind", { kind: t(`kinds.${fixedKind}`) }) : t("create.title")
          }
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
                disabled={title.trim() === "" || projectId === ""}
                onClick={submit}
              >
                {t("create.submit")}
              </Button>
            </>
          }
        >
          <form
            className="flex flex-col gap-12"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <ActionErrorAlert error={error} />
            {fixedKind ? null : (
              <Select
                id="create-kind"
                label={t("fields.kind")}
                value={kind}
                options={kinds.map((k) => ({
                  value: k.kind,
                  label: `${t(`kinds.${k.kind}`)} · ${t(`classes.${k.recordClass}`)}`,
                }))}
                onChange={(e) => {
                  const next = e.target.value;
                  setKind(next);
                  setSubtype("");
                  setXyz(defaultXyz(kinds.find((k) => k.kind === next)?.recordClass, xyzTags));
                }}
              />
            )}
            {info && info.subtypes.length > 0 ? (
              <Select
                key={kind}
                id="create-subtype"
                label={t("fields.subtype")}
                value={subtype}
                options={[
                  { value: "", label: t("values.none") },
                  ...info.subtypes.map((s) => ({ value: s, label: t(`subtypes.${kind}.${s}`) })),
                ]}
                onChange={(e) => setSubtype(e.target.value)}
              />
            ) : null}
            <Input
              id="create-title"
              label={t("fields.title")}
              help={t(`grammar.${kind}`)}
              value={title}
              width="100%"
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
            {fixedProjectId || projects.length === 1 ? null : (
              <Select
                id="create-project"
                label={t("fields.project")}
                value={projectId}
                options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
                onChange={(e) => setProjectId(e.target.value)}
              />
            )}
            <Select
              id="create-owner"
              label={t("fields.owner")}
              value={owner}
              options={[
                { value: "", label: t("values.unassigned") },
                ...people.map((p) => ({ value: p.personId, label: p.name ?? t("values.unnamed") })),
              ]}
              onChange={(e) => setOwner(e.target.value)}
            />
            <Input
              id="create-due"
              type="datetime-local"
              label={t("fields.due")}
              help={t("fields.zoneNote", { zone: tz })}
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <CustomFieldInputs table="app.records" ref={custom} />
            {more ? (
              <>
                <Input
                  id="create-starts"
                  type="datetime-local"
                  label={t("fields.starts")}
                  value={starts}
                  onChange={(e) => setStarts(e.target.value)}
                />
                <Input
                  id="create-ends"
                  type="datetime-local"
                  label={t("fields.ends")}
                  value={ends}
                  onChange={(e) => setEnds(e.target.value)}
                />
                <Select
                  id="create-phase"
                  label={t("fields.phase")}
                  value={phase}
                  options={[
                    { value: "", label: t("values.none") },
                    ...phases.map((p) => ({
                      value: p.value,
                      label: t("values.gate", { gate: p.gate, name: p.label }),
                    })),
                  ]}
                  onChange={(e) => setPhase(e.target.value)}
                />
                <Input
                  id="create-urid"
                  label={t("fields.urid")}
                  help={t("fields.uridHelp")}
                  value={urid}
                  inputMode="decimal"
                  onChange={(e) => setUrid(e.target.value)}
                />
                <Select
                  id="create-xyz"
                  label={t("fields.xyz")}
                  help={t("fields.xyzHelp")}
                  value={xyz}
                  options={xyzTags.map((x) => ({ value: x, label: t(`xyz.${x}`) }))}
                  onChange={(e) => setXyz(e.target.value)}
                />
              </>
            ) : (
              <div>
                <Button variant="ghost" onClick={() => setMore(true)}>
                  {t("create.more")}
                </Button>
              </div>
            )}
          </form>
        </Drawer>
      ) : null}
    </>
  );
}
