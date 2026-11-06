"use client";

import { Button, InlineAlert, Select, Textarea } from "@xos/ui";
import { undoStack } from "@xos/ui/undo";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import {
  completeDebriefAction,
  deleteDebriefPointAction,
  reopenDebriefAction,
  restoreDebriefPointAction,
  saveDebriefPointAction,
  saveDebriefSummaryAction,
  type WrapUpResult,
} from "@/app/[org]/p/[projectKey]/reports/wrap-up-actions";
import { SummaryEntry } from "@/components/aurora/entry/summary-entry";

type Option = { readonly value: string; readonly label: string };

export interface WrapUpPoint {
  readonly id: string;
  readonly area: string;
  readonly kind: string;
  readonly body: string;
  readonly ownerMembershipId: string | null;
  readonly ownerName: string | null;
}

export interface WrapUpLabels {
  readonly summaryLabel: string;
  readonly summaryHelp: string;
  readonly saveSummary: string;
  readonly summarySaved: string;
  readonly useSummary: string;
  readonly aiPending: string;
  readonly points: string;
  readonly area: string;
  readonly kind: string;
  readonly point: string;
  readonly owner: string;
  readonly noOwner: string;
  readonly addPoint: string;
  readonly savePoint: string;
  readonly edit: string;
  readonly delete: string;
  readonly cancel: string;
  readonly trashed: string;
  readonly noPoints: string;
  readonly complete: string;
  readonly reopen: string;
  readonly areas: readonly Option[];
  readonly kinds: readonly Option[];
  readonly errors: Readonly<Record<string, string>>;
}

/**
 * The editable part of the project wrap-up (B7, ADR 0146 decisions 5 and 6): the management summary, drafted with
 * Aurora (SummaryEntry, kind project_wrap_up) or typed, written only on Save with the request it came from; the
 * debrief points (add, edit, delete with Undo); and Complete or Reopen. A completed debrief locks the points and the
 * summary until it is reopened. Loaded on demand (components/lazy-ui/wrap-up-panel.tsx); labels come from the server.
 */
export function WrapUpPanel({
  org,
  projectKey,
  project,
  debriefId,
  completed,
  canWrite,
  summary,
  summaryReadable,
  points,
  owners,
  labels,
}: {
  org: string;
  projectKey: string;
  project: { readonly id: string; readonly label: string };
  debriefId: string | null;
  completed: boolean;
  canWrite: boolean;
  summary: string;
  summaryReadable: boolean;
  points: readonly WrapUpPoint[];
  owners: readonly Option[];
  labels: WrapUpLabels;
}) {
  const id = useId();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [text, setText] = useState(summary);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WrapUpPoint | "new" | null>(null);
  const editable = canWrite && !completed;
  const where = { org, projectKey };
  const answer = (r: WrapUpResult) => {
    if (!r.ok) {
      setError(labels.errors[r.key] ?? labels.errors["unexpected"] ?? r.key);
      return false;
    }
    setError(null);
    router.refresh();
    return true;
  };
  const act = (fn: () => Promise<WrapUpResult>, then?: () => void) =>
    start(async () => {
      if (answer(await fn())) then?.();
    });

  return (
    <div className="flex flex-col gap-16" data-testid="wrap-up-panel">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {summaryReadable ? (
        <div className="flex flex-col gap-8">
          <Textarea
            id={`${id}-summary`}
            label={labels.summaryLabel}
            help={labels.summaryHelp}
            width="100%"
            rows={6}
            maxLength={4000}
            value={text}
            disabled={!editable}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
          />
          {requestId ? (
            <p className="m-0 text-text-12 text-text-secondary">{labels.aiPending}</p>
          ) : null}
          {editable ? (
            <div className="flex flex-wrap items-center gap-8">
              <SummaryEntry
                subject={{ collection: "projects", id: project.id, label: project.label }}
                kinds={["project_wrap_up"]}
                project={{ org, key: projectKey }}
                use={{
                  label: labels.useSummary,
                  onUse: (draft, request) => {
                    setText(draft.slice(0, 4000));
                    setRequestId(request);
                    setSaved(false);
                  },
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                loading={pending}
                onClick={() =>
                  act(
                    () =>
                      saveDebriefSummaryAction({ ...where, summary: text, aiRequestId: requestId }),
                    () => {
                      setSaved(true);
                      setRequestId(null);
                    },
                  )
                }
              >
                {labels.saveSummary}
              </Button>
              {saved ? (
                <span className="text-text-13 text-success-text">{labels.summarySaved}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby={`${id}-points`} className="flex flex-col gap-8">
        <h3 id={`${id}-points`} className="m-0 text-heading-14 font-semibold">
          {labels.points}
        </h3>
        {points.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{labels.noPoints}</p>
        ) : (
          <table className="w-full border-collapse text-text-13">
            <thead>
              <tr className="text-start text-text-12 text-text-secondary">
                <th scope="col" className="py-4 text-start font-medium">
                  {labels.area}
                </th>
                <th scope="col" className="py-4 text-start font-medium">
                  {labels.kind}
                </th>
                <th scope="col" className="py-4 text-start font-medium">
                  {labels.point}
                </th>
                <th scope="col" className="py-4 text-start font-medium">
                  {labels.owner}
                </th>
                {editable ? (
                  <th scope="col">
                    <span className="sr-only">{labels.edit}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-border-subtle align-top"
                  data-testid="debrief-point"
                >
                  <td className="py-8 pe-8">
                    {labels.areas.find((a) => a.value === p.area)?.label ?? p.area}
                  </td>
                  <td className="py-8 pe-8">
                    {labels.kinds.find((k) => k.value === p.kind)?.label ?? p.kind}
                  </td>
                  <td className="whitespace-pre-line py-8 pe-8">{p.body}</td>
                  <td className="py-8 pe-8">
                    {p.ownerName ?? (p.kind === "Action" ? labels.noOwner : "")}
                  </td>
                  {editable ? (
                    <td className="py-8">
                      <span className="inline-flex gap-4">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                          {labels.edit}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={pending}
                          onClick={() =>
                            act(
                              () => deleteDebriefPointAction({ ...where, id: p.id }),
                              () =>
                                undoStack.push({
                                  label: labels.trashed,
                                  undo: async () => {
                                    const r = await restoreDebriefPointAction({
                                      ...where,
                                      id: p.id,
                                    });
                                    router.refresh();
                                    return r.ok
                                      ? { ok: true }
                                      : { ok: false, message: labels.errors[r.key] ?? r.key };
                                  },
                                  redo: async () => {
                                    const r = await deleteDebriefPointAction({
                                      ...where,
                                      id: p.id,
                                    });
                                    router.refresh();
                                    return r.ok
                                      ? { ok: true }
                                      : { ok: false, message: labels.errors[r.key] ?? r.key };
                                  },
                                }),
                            )
                          }
                        >
                          {labels.delete}
                        </Button>
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {editable && editing === null ? (
          <div>
            <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
              {labels.addPoint}
            </Button>
          </div>
        ) : null}
        {editable && editing !== null ? (
          <PointForm
            key={editing === "new" ? "new" : editing.id}
            point={editing === "new" ? null : editing}
            owners={owners}
            labels={labels}
            pending={pending}
            onCancel={() => setEditing(null)}
            onSave={(value) =>
              act(
                () =>
                  saveDebriefPointAction({
                    ...where,
                    id: editing === "new" ? null : editing.id,
                    ...value,
                  }),
                () => setEditing(null),
              )
            }
          />
        ) : null}
      </section>

      {canWrite && debriefId ? (
        <div className="flex flex-wrap gap-8">
          {completed ? (
            <Button
              variant="secondary"
              loading={pending}
              onClick={() => act(() => reopenDebriefAction({ ...where, id: debriefId }))}
            >
              {labels.reopen}
            </Button>
          ) : (
            <Button
              variant="secondary"
              loading={pending}
              onClick={() => act(() => completeDebriefAction({ ...where, id: debriefId }))}
            >
              {labels.complete}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PointForm({
  point,
  owners,
  labels,
  pending,
  onCancel,
  onSave,
}: {
  point: WrapUpPoint | null;
  owners: readonly Option[];
  labels: WrapUpLabels;
  pending: boolean;
  onCancel: () => void;
  onSave: (value: {
    area: string;
    kind: string;
    body: string;
    ownerMembershipId: string | null;
  }) => void;
}) {
  const id = useId();
  const [area, setArea] = useState(point?.area ?? labels.areas[0]?.value ?? "Other");
  const [kind, setKind] = useState(point?.kind ?? labels.kinds[0]?.value ?? "Went Well");
  const [body, setBody] = useState(point?.body ?? "");
  const [owner, setOwner] = useState(point?.ownerMembershipId ?? "");
  return (
    <form
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ area, kind, body, ownerMembershipId: kind === "Action" && owner ? owner : null });
      }}
    >
      <div className="flex flex-wrap gap-12">
        <Select
          id={`${id}-area`}
          label={labels.area}
          value={area}
          options={[...labels.areas]}
          onChange={(e) => setArea(e.target.value)}
        />
        <Select
          id={`${id}-kind`}
          label={labels.kind}
          value={kind}
          options={[...labels.kinds]}
          onChange={(e) => setKind(e.target.value)}
        />
        {kind === "Action" ? (
          <Select
            id={`${id}-owner`}
            label={labels.owner}
            value={owner}
            options={[{ value: "", label: labels.noOwner }, ...owners]}
            onChange={(e) => setOwner(e.target.value)}
          />
        ) : null}
      </div>
      <Textarea
        id={`${id}-body`}
        label={labels.point}
        width="100%"
        rows={3}
        maxLength={2000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex gap-8">
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          {labels.savePoint}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  );
}
