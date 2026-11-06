"use client";

import { Button, Checkbox, InlineAlert, MultiSelect, QRCode, Select, Tag } from "@xos/ui";
import type { CrewAccessWorker, CrewAccessWorkerRef } from "@xos/data/crew-access";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import {
  crewAccessWorkersAction,
  issueCrewAccessLinksAction,
  type IssuedLink,
  type IssueState,
} from "@/app/[org]/crew/access-links/actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

const VALIDITY_DAYS = ["1", "3", "7", "14", "30"];
const INITIAL: IssueState = {};

const workerKey = (w: CrewAccessWorkerRef) => JSON.stringify(w);

/** The link and code of one worker, once, with a card to print. */
function IssuedCard({
  link,
  includeCode,
  projectName,
}: {
  link: IssuedLink;
  includeCode: boolean;
  projectName: string;
}) {
  const t = useTranslations("crew.crewAccess.result");
  const format = useFormatter();
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const copy = async (what: "link" | "code", text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
  };
  const absolute = /^https?:\/\//.test(link.url);
  return (
    <li className="flex flex-col gap-8 rounded-card border border-border-subtle p-12 print:break-inside-avoid">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div className="flex min-w-0 flex-col gap-4">
          <p className="m-0 text-text-14 font-semibold">{link.personName ?? t("unnamed")}</p>
          <p className="m-0 text-text-12 text-text-secondary">
            {t("card", {
              project: projectName,
              expires: format.dateTime(new Date(link.expiresAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}
          </p>
          <p className="m-0 break-all font-mono text-text-12">{link.url}</p>
          <p className="m-0 text-text-13 print:hidden">
            {t("code")} <span className="font-mono font-semibold">{link.accessCode}</span>
          </p>
          {includeCode ? (
            <p className="m-0 hidden text-text-13 print:block">
              {t("code")} <span className="font-mono font-semibold">{link.accessCode}</span>
            </p>
          ) : null}
        </div>
        {absolute ? (
          <QRCode value={link.url} label={t("qr", { name: link.personName ?? "" })} size={120} />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-8 print:hidden">
        <Button type="button" variant="secondary" onClick={() => void copy("link", link.url)}>
          {t("copyLink")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void copy("code", link.accessCode)}
        >
          {t("copyCode")}
        </Button>
        {copied ? (
          <span role="status" className="text-text-12 text-text-secondary">
            {t(copied === "link" ? "copiedLink" : "copiedCode")}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Holds the tokens only in this component: nothing refreshes the page until the person closes it. */
function ResultPanel({ state, closeHref }: { state: IssueState; closeHref: string }) {
  const t = useTranslations("crew.crewAccess.result");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const links = state.links ?? [];
  return (
    <section aria-labelledby="crew-access-result" className="flex flex-col gap-12">
      <h2 id="crew-access-result" className="m-0 text-heading-16 font-semibold print:hidden">
        {t("title", { count: links.length })}
      </h2>
      <InlineAlert tone="warning">{t("once")}</InlineAlert>
      <ul className="m-0 flex list-none flex-col gap-12 p-0">
        {links.map((link) => (
          <IssuedCard
            key={link.linkId}
            link={link}
            includeCode={state.includeCode === true}
            projectName={state.projectName ?? ""}
          />
        ))}
      </ul>
      <div className="flex flex-wrap gap-8 print:hidden">
        <Button type="button" variant="secondary" onClick={() => window.print()}>
          {t("print")}
        </Button>
        {confirming ? (
          <>
            <p className="m-0 w-full text-text-13">{t("closeConfirm")}</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                router.push(closeHref as Route);
                router.refresh();
              }}
            >
              {t("closeSure")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              {t("keepOpen")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
            {t("close")}
          </Button>
        )}
      </div>
    </section>
  );
}

/** Issue links: project, workers, validity, and whether a printed card carries the code. Four fields. */
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
      <MultiSelect
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
        <Checkbox name="includeCode" value="true" label={t("includeCode")} />
        <p className="m-0 text-text-12 text-text-secondary">{t("includeCodeHelp")}</p>
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
