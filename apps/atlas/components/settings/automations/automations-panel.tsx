"use client";

import { Button, IconButton, InlineAlert, Switch, Tag } from "@xos/ui";
import dynamic from "next/dynamic";
import { useFormatter } from "next-intl";
import { useAutomationCopy } from "./copy";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  deleteAutomationAction,
  setAutomationEnabledAction,
} from "@/app/[org]/settings/automation-actions";
import { Dialog } from "@/components/lazy-ui/dialog";
import { runTone } from "./run-tone";

/**
 * Settings, Automations (A91, Section 4.5.6 item 20, ADR 0047): the org's automations with an on switch, their latest
 * run and who they run as, and the org's recent runs. The editor and the run details load on demand (next/dynamic,
 * ADR 0027): this module is all a settings page carries until one opens.
 */
const AutomationEditor = dynamic(() =>
  import("./automation-editor").then((m) => m.AutomationEditor),
);
const RunDetails = dynamic(() => import("./run-details").then((m) => m.RunDetails));

export interface PanelAutomation {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly triggerEventType: string;
  readonly enabled: boolean;
  readonly pauseReason: string | null;
  readonly ownerName: string | null;
  readonly lastRun: { readonly status: string; readonly at: string } | null;
}

export interface PanelRun {
  readonly id: string;
  readonly automationId: string;
  readonly automationName: string | null;
  readonly status: string;
  readonly eventType: string;
  readonly createdAt: string;
  readonly durationMs: number | null;
}

type RunView =
  | { readonly kind: "run"; readonly runId: string; readonly name: string }
  | { readonly kind: "automation"; readonly automationId: string; readonly name: string };

export function AutomationsPanel({
  org,
  canEdit,
  inPlan,
  automations,
  runs,
}: {
  org: string;
  canEdit: boolean;
  inPlan: boolean;
  automations: readonly PanelAutomation[];
  runs: readonly PanelRun[];
}) {
  const t = useAutomationCopy();
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [runView, setRunView] = useState<RunView | null>(null);
  const [deleting, setDeleting] = useState<PanelAutomation | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const writable = canEdit && inPlan;
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  const act = (work: () => Promise<{ ok?: boolean; error?: string }>, done: string) =>
    startTransition(async () => {
      const result = await work();
      setError(result.error ?? "");
      setStatus(result.ok ? done : "");
      router.refresh();
    });

  return (
    <section aria-labelledby="automations-heading" className="flex flex-col gap-16">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div className="flex flex-col gap-4">
          <h2 id="automations-heading" className="m-0 text-text-15 font-semibold">
            {t("list.caption")}
          </h2>
          <p className="m-0 max-w-[72ch] text-text-13 text-text-secondary">{t("intro")}</p>
        </div>
        {writable ? (
          <Button variant="primary" icon="Plus" onClick={() => setEditing({ id: null })}>
            {t("new")}
          </Button>
        ) : null}
      </div>
      {!inPlan ? (
        <InlineAlert tone="info">
          {t("notInPlan")}{" "}
          <a className="underline" href={`/${org}/settings/billing-and-plan`}>
            {t("upgrade")}
          </a>
        </InlineAlert>
      ) : null}
      {inPlan && !canEdit ? <InlineAlert tone="info">{t("readOnly")}</InlineAlert> : null}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <p role="status" className="m-0 text-text-13 text-text-secondary">
        {status}
      </p>

      {automations.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-text-13">
            <caption className="sr-only">{t("list.caption")}</caption>
            <thead>
              <tr className="border-b border-border-subtle text-start text-text-12 text-text-secondary">
                <th scope="col" className="py-8 pe-12 text-start font-medium">
                  {t("list.name")}
                </th>
                <th scope="col" className="py-8 pe-12 text-start font-medium">
                  {t("list.trigger")}
                </th>
                <th scope="col" className="py-8 pe-12 text-start font-medium">
                  {t("list.status")}
                </th>
                <th scope="col" className="py-8 pe-12 text-start font-medium">
                  {t("list.lastRun")}
                </th>
                <th scope="col" className="py-8 pe-12 text-start font-medium">
                  {t("list.owner")}
                </th>
                <th scope="col" className="py-8 text-end font-medium">
                  {t("list.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {automations.map((a) => (
                <tr key={a.id} className="border-b border-border-subtle align-top">
                  <td className="py-8 pe-12">
                    <span className="block font-medium">{a.name}</span>
                    {a.description ? (
                      <span className="block text-text-12 text-text-secondary">
                        {a.description}
                      </span>
                    ) : null}
                    {a.pauseReason ? (
                      <span className="mt-4 block text-text-12 text-warning-text">
                        {t("paused", { reason: a.pauseReason, owner: a.ownerName ?? "" })}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-8 pe-12">
                    <code className="text-text-12">{a.triggerEventType}</code>
                  </td>
                  <td className="py-8 pe-12">
                    <Switch
                      label={<span className="sr-only">{t("toggle", { name: a.name })}</span>}
                      checked={a.enabled}
                      disabled={pending || !canEdit || (!inPlan && !a.enabled)}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        act(() => setAutomationEnabledAction(org, a.id, on), t("editor.saved"));
                      }}
                    />
                  </td>
                  <td className="py-8 pe-12">
                    {a.lastRun ? (
                      <span className="flex flex-col gap-4">
                        <Tag tone={runTone(a.lastRun.status)}>
                          {t(`runStatus.${a.lastRun.status}`)}
                        </Tag>
                        <span className="text-text-12 text-text-secondary">
                          {when(a.lastRun.at)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-text-secondary">{t("never")}</span>
                    )}
                  </td>
                  <td className="py-8 pe-12">{a.ownerName ?? ""}</td>
                  <td className="py-8">
                    <span className="flex justify-end gap-4">
                      {writable ? (
                        <IconButton
                          icon="Pencil"
                          label={t("edit", { name: a.name })}
                          onClick={() => setEditing({ id: a.id })}
                        />
                      ) : null}
                      <IconButton
                        icon="Clock"
                        label={t("history", { name: a.name })}
                        onClick={() =>
                          setRunView({ kind: "automation", automationId: a.id, name: a.name })
                        }
                      />
                      {canEdit ? (
                        <IconButton
                          icon="Trash2"
                          label={t("delete", { name: a.name })}
                          onClick={() => setDeleting(a)}
                        />
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section aria-labelledby="automation-runs-heading" className="flex flex-col gap-8">
        <h3 id="automation-runs-heading" className="m-0 text-text-14 font-semibold">
          {t("runs.title")}
        </h3>
        {runs.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("runs.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-text-13">
              <caption className="sr-only">{t("runs.caption")}</caption>
              <thead>
                <tr className="border-b border-border-subtle text-text-12 text-text-secondary">
                  <th scope="col" className="py-8 pe-12 text-start font-medium">
                    {t("runs.automation")}
                  </th>
                  <th scope="col" className="py-8 pe-12 text-start font-medium">
                    {t("runs.event")}
                  </th>
                  <th scope="col" className="py-8 pe-12 text-start font-medium">
                    {t("runs.status")}
                  </th>
                  <th scope="col" className="py-8 pe-12 text-start font-medium">
                    {t("runs.when")}
                  </th>
                  <th scope="col" className="py-8 pe-12 text-start font-medium">
                    {t("runs.duration")}
                  </th>
                  <th scope="col" className="py-8 text-end font-medium">
                    <span className="sr-only">{t("runs.details")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-border-subtle">
                    <td className="py-8 pe-12">{r.automationName ?? ""}</td>
                    <td className="py-8 pe-12">
                      <code className="text-text-12">{r.eventType}</code>
                    </td>
                    <td className="py-8 pe-12">
                      <Tag tone={runTone(r.status)}>{t(`runStatus.${r.status}`)}</Tag>
                    </td>
                    <td className="py-8 pe-12">{when(r.createdAt)}</td>
                    <td className="py-8 pe-12">
                      {r.durationMs === null ? "" : t("run.ms", { ms: r.durationMs })}
                    </td>
                    <td className="py-8 text-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setRunView({ kind: "run", runId: r.id, name: r.automationName ?? "" })
                        }
                      >
                        {t("runs.details")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing ? (
        <AutomationEditor
          org={org}
          automationId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setError("");
            setStatus(message);
            router.refresh();
          }}
        />
      ) : null}
      {runView ? (
        <RunDetails org={org} view={runView} canRetry={writable} onClose={() => setRunView(null)} />
      ) : null}
      {deleting ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title={t("delete", { name: deleting.name })}
          description={t("deleteConfirm", { name: deleting.name })}
          actions={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                {t("editor.cancel")}
              </Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() => {
                  const target = deleting;
                  setDeleting(null);
                  act(() => deleteAutomationAction(org, target.id), t("deleted"));
                }}
              >
                {t("delete", { name: deleting.name })}
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      ) : null}
    </section>
  );
}
