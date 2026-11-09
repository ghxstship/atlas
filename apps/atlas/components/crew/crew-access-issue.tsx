"use client";

import { Button, InlineAlert, Select, Tag } from "@xos/ui";
import type { CrewAccessWorker, CrewAccessWorkerRef } from "@xos/data/crew-access";
import type { Route } from "next";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import {
  crewAccessWorkersAction,
  issueCrewAccessLinksAction,
  type IssueState,
} from "@/app/[org]/crew/access-links/actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

const VALIDITY_DAYS = ["1", "3", "7", "14", "30"];
const INITIAL: IssueState = {};

const workerKey = (w: CrewAccessWorkerRef) => JSON.stringify(w);

const WorkerPicker = dynamic(() => import("./crew-access-picker").then((m) => m.WorkerPicker));
const ResultPanel = dynamic(() => import("./crew-access-result").then((m) => m.ResultPanel));

/** Issue links: project, workers and validity. A printed card never carries the code (owner ruling, invariant 8). */
export function CrewAccessIssue({
  org,
  projects,
  initialProject,
  closeHref,
}: {
  org: string;
  projects: readonly { id: string; name: string }[];
  initialProject: string | null;
  closeHref: string;
}) {
  const t = useTranslations("crew.crewAccess.issue");
  const refusals = useTranslations("crew.crewAccess.refusals") as unknown as Translate;
  const [state, formAction, pending] = useActionState(issueCrewAccessLinksAction, INITIAL);
  const keep = useKeepInput(state, formAction, () => false);
  const [project, setProject] = useState(initialProject ?? projects[0]?.id ?? "");
  const [workers, setWorkers] = useState<readonly CrewAccessWorker[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    let live = true;
    if (project) {
      void crewAccessWorkersAction({ org, projectId: project }).then((list) => {
        if (live) setWorkers(list);
      });
    }
    return () => {
      live = false;
    };
  }, [org, project]);
  if (state.links && state.links.length > 0)
    return <ResultPanel state={state} closeHref={closeHref} />;
  const projectName = projects.find((p) => p.id === project)?.name ?? "";
  return (
    <form
      action={formAction}
      {...keep}
      className="flex max-w-layout-form flex-col gap-12"
      aria-label={t("title")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="projectName" value={projectName} />
      <input type="hidden" name="workers" value={`[${picked.join(",")}]`} />
      {state.rule ? (
        <InlineAlert tone="danger">
          {refusals.has(state.rule)
            ? refusals(state.rule)
            : refusals("generic", { rule: state.rule })}
        </InlineAlert>
      ) : state.error ? (
        <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>
      ) : null}
      <Select
        name="projectId"
        label={t("project")}
        value={project}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
        onChange={(e) => {
          setProject(e.target.value);
          setPicked([]);
        }}
      />
      {choosing ? (
        <WorkerPicker
          key={project}
          label={t("workers")}
          help={t("workersHelp")}
          value={picked}
          options={workers.map((w) => ({
            value: workerKey(w.ref),
            label: w.hasLiveLink ? t("workerWithLink", { name: w.personName }) : w.personName,
          }))}
          onChange={setPicked}
        />
      ) : (
        <div>
          <Button type="button" size="sm" onClick={() => setChoosing(true)}>
            {t("chooseWorkers")}
          </Button>
        </div>
      )}
      <Select
        name="validFor"
        label={t("validFor")}
        value="7"
        options={VALIDITY_DAYS.map((d) => ({
          value: d,
          label: t("validDays", { days: Number(d) }),
        }))}
      />
      <div className="flex flex-col gap-4">
        <p className="m-0 text-text-12 text-text-secondary">{t("printedCardHelp")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-8">
        <Button
          type="submit"
          variant="primary"
          disabled={pending || picked.length === 0}
          aria-busy={pending}
        >
          {t("submit")}
        </Button>
        <Link
          href={closeHref as Route}
          className="text-text-13 text-text-secondary hover:text-text-primary"
        >
          {t("cancel")}
        </Link>
        {workers.some((w) => w.hasLiveLink) ? <Tag tone="neutral">{t("replaces")}</Tag> : null}
      </div>
    </form>
  );
}
