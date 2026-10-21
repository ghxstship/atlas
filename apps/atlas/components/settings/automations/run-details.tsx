"use client";

import type { AutomationRunRow, AutomationStepRow } from "@xos/data/automations";
import { Button, Drawer, InlineAlert, Tag } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useAutomationCopy } from "./copy";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  automationRunStepsAction,
  automationRunsAction,
  retryAutomationRunAction,
} from "@/app/[org]/settings/automation-actions";
import { runTone } from "./run-tone";

/**
 * Run history (A91, ADR 0047), loaded when a person opens it: an automation's runs newest first, or one run, each with
 * its steps (the API operation called as the owner, what it sent and answered, how long it took) and a retry for a
 * failed run.
 */

type View =
  | { readonly kind: "run"; readonly runId: string; readonly name: string }
  | { readonly kind: "automation"; readonly automationId: string; readonly name: string };

function RunSteps({
  org,
  run,
  canRetry,
}: {
  org: string;
  run: AutomationRunRow;
  canRetry: boolean;
}) {
  const t = useAutomationCopy();
  const router = useRouter();
  const [steps, setSteps] = useState<AutomationStepRow[] | null | undefined>(undefined);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  useEffect(() => {
    let live = true;
    void automationRunStepsAction(org, run.id).then((loaded) => {
      if (live) setSteps(loaded);
    });
    return () => {
      live = false;
    };
  }, [org, run.id]);
  return (
    <div className="flex flex-col gap-8">
      {run.depth > 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("run.caused", { depth: run.depth })}
        </p>
      ) : null}
      <p className="m-0 text-text-12 text-text-secondary">
        {t("run.attempts", { count: run.attempts })}
      </p>
      {run.errorMessage ? (
        <p className="m-0 text-text-13">
          <span className="font-medium">{t("run.error")}: </span>
          {run.errorMessage}
        </p>
      ) : null}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {message ? (
        <p role="status" className="m-0 text-text-13">
          {message}
        </p>
      ) : null}
      {canRetry && run.status === "Failed" ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon="RefreshCw"
            loading={pending}
            onClick={() =>
              start(async () => {
                const result = await retryAutomationRunAction(org, run.id);
                setError(result.error ?? "");
                setMessage(result.ok ? t("run.retried") : "");
                router.refresh();
              })
            }
          >
            {t("run.retry")}
          </Button>
        </div>
      ) : null}
      <h4 className="m-0 text-text-13 font-medium">{t("run.steps")}</h4>
      {steps === undefined ? null : steps === null ? (
        <InlineAlert tone="danger">{t("run.loadFailed")}</InlineAlert>
      ) : steps.length === 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("run.noSteps")}</p>
      ) : (
        <ol className="m-0 flex flex-col gap-8 ps-16 text-text-12">
          {steps.map((s) => (
            <li key={s.position} className="flex flex-col gap-4">
              <span className="flex flex-wrap items-center gap-8">
                <span className="font-medium">{t(`editor.actionTypes.${s.actionType}`)}</span>
                <Tag tone={runTone(s.status)}>{t(`stepStatus.${s.status}`)}</Tag>
                {s.operationId ? <code>{s.operationId}</code> : null}
                {s.httpStatus === null ? null : (
                  <span>{t("run.http", { status: s.httpStatus })}</span>
                )}
                <span className="text-text-secondary">{t("run.ms", { ms: s.durationMs })}</span>
              </span>
              {s.errorMessage ? <span>{s.errorMessage}</span> : null}
              {s.request ? (
                <details>
                  <summary>{t("run.sent")}</summary>
                  <pre className="m-0 overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(s.request, null, 2)}
                  </pre>
                </details>
              ) : null}
              {s.response ? (
                <details>
                  <summary>{t("run.answered")}</summary>
                  <pre className="m-0 overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(s.response, null, 2)}
                  </pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <details>
        <summary className="text-text-12">{t("run.event")}</summary>
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap text-text-12">
          {JSON.stringify(run.event, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function RunDetails({
  org,
  view,
  canRetry,
  onClose,
}: {
  org: string;
  view: View;
  canRetry: boolean;
  onClose: () => void;
}) {
  const t = useAutomationCopy();
  const format = useFormatter();
  const [runs, setRuns] = useState<AutomationRunRow[] | null | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [paging, start] = useTransition();
  const automationId = view.kind === "automation" ? view.automationId : null;

  useEffect(() => {
    let live = true;
    void automationRunsAction(
      org,
      automationId,
      null,
      view.kind === "run" ? view.runId : null,
    ).then((loaded) => {
      if (!live) return;
      setRuns(loaded);
      setMore(view.kind === "automation" && (loaded?.length ?? 0) >= 20);
    });
    return () => {
      live = false;
    };
  }, [org, automationId, view]);

  const title =
    view.kind === "run" ? t("run.title", { name: view.name }) : t("history", { name: view.name });
  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t("run.close")}
        </Button>
      }
    >
      {runs === undefined ? null : runs === null ? (
        <InlineAlert tone="danger">{t("run.loadFailed")}</InlineAlert>
      ) : runs.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("runs.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-16 p-0">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-col gap-8 border-b border-border-subtle pb-12">
              <span className="flex flex-wrap items-center gap-8 text-text-13">
                <Tag tone={runTone(run.status)}>{t(`runStatus.${run.status}`)}</Tag>
                <code className="text-text-12">{run.eventType}</code>
                <span className="text-text-secondary">
                  {format.dateTime(new Date(run.createdAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
                {run.durationMs === null ? null : (
                  <span className="text-text-secondary">{t("run.ms", { ms: run.durationMs })}</span>
                )}
              </span>
              <RunSteps org={org} run={run} canRetry={canRetry} />
            </li>
          ))}
        </ul>
      )}
      {more && runs ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={paging}
            onClick={() =>
              start(async () => {
                const last = runs[runs.length - 1];
                const older = await automationRunsAction(
                  org,
                  automationId,
                  last?.createdAt ?? null,
                );
                setRuns([...runs, ...(older ?? [])]);
                setMore((older?.length ?? 0) >= 20);
              })
            }
          >
            {t("runs.older")}
          </Button>
        </div>
      ) : null}
    </Drawer>
  );
}
